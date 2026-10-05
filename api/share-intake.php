<?php

declare(strict_types=1);

/**
 * The share intake — the server half of the Web Share Target.
 *
 * A manifest allows exactly ONE share target. This app needs one that takes a
 * link and some text, and one that takes a photograph off the phone's gallery,
 * and the spec does not have a way to declare both. So the target is a POST of
 * `multipart/form-data`, which is the only form in which a browser will hand a
 * shared FILE to a web app at all, and the four destinations the app already
 * had for a shared link are still chosen on the /share screen afterwards.
 *
 * That is the whole reason any of this exists. The alternative — the GET target
 * the manifest had before, which is what makes sharing work with no server at
 * all — cannot carry a file, and the file is the point.
 *
 * ---------------------------------------------------------------------------
 * Why the bytes pass through the server and then stop
 * ---------------------------------------------------------------------------
 *
 * A service worker cannot see a POST navigation: the fetch event is not
 * dispatched for one, so there is nowhere in the client to intercept the upload
 * and no way to keep it on the device. The browser posts the file to the server,
 * the server parks it, and answers with a 303 to /share?t=<token>. The app then
 * fetches the parked bytes back and writes them into IndexedDB — where they
 * live from then on, on that device, and are never uploaded again.
 *
 * So this is a LAYER, not a storage backend. There is no user, no space, no
 * quota per account, and nothing here is ever read twice by a human: the token
 * is random, it is good for ten minutes, and it is dropped the moment the last
 * part is served or the window closes.
 *
 * ---------------------------------------------------------------------------
 * Why the body is parsed by hand
 * ---------------------------------------------------------------------------
 *
 * `file_uploads = Off` is one of the app's hardening defaults (see
 * docker/php/php.ini: "the app never accepts file uploads"). Rather than turn it
 * on — which would mean a php.ini `post_max_size` large enough for a video, and
 * therefore a SAPI that buffers that much on EVERY unauthenticated POST before
 * the app's own 1 MiB ceiling is consulted — the body is read from php://input
 * and the multipart envelope is unwrapped by this file.
 *
 * php://input is only readable for a multipart body when the SAPI has been told
 * not to consume it, which is `enable_post_data_reading = 0`. That setting is
 * set in docker/php/php.ini, and it is ALSO required for `php -S` (which
 * `npm run dev` runs) via `-d enable_post_data_reading=0`. Nothing in the app
 * reads $_POST, $_GET or $_FILES, so the setting costs it nothing and removes
 * the SAPI's double buffering of every request body.
 *
 * Where the setting is missing, the body arrives empty and this endpoint says
 * `share_intake_unavailable` rather than pretending it worked — and the client
 * falls back to the attachment picker, so the user loses the one-tap share and
 * nothing else.
 */

// The parts of the body that are not files. Named to match the manifest's
// share_target params, so what the browser was told to send and what is read
// here cannot drift.
const TT_SHARE_FIELDS = ['title', 'text', 'url'];

// The manifest may send a different field name for the files; both spellings
// are accepted because `files` is the spec's name and `file` is what some
// older documentation used.
const TT_SHARE_FILE_FIELDS = ['files', 'file'];

// How long a parked share is good for. Long enough for a person to look at the
// chooser, pick a destination and press save; short enough that a share
// abandoned in a background tab is not still there in the morning.
const TT_SHARE_TTL_S = 600;

// The MIME types a shared file may arrive as. The SAME list the client's
// domain/attachments.js applies, and it is a closed list on purpose: a file
// this server would store and hand back is a file that could be made to execute
// in the app's origin, and the answer to that is a list of what is allowed
// rather than a list of what is not. No text/html, no image/svg+xml.
const TT_SHARE_MEDIA_PREFIXES = ['image/', 'audio/', 'video/'];

// Types that are inside a broad allowlist above and still must never be stored,
// checked FIRST. SVG is an image by MIME and a script by everything that
// matters: it can carry <script>, it can carry an onload handler, and a browser
// asked to render one on this origin would run it. `image/svg+xml` is therefore
// not a photo here, however much it looks like one, and `text/html` is listed
// beside it for the same reason — a prefix rule must never be the only rule.
const TT_SHARE_REFUSED_TYPES = [
    'image/svg+xml',
    'text/html',
    'application/xhtml+xml',
    'application/xml',
    'text/xml',
];

const TT_SHARE_DOCUMENT_TYPES = [
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'application/rtf',
    'application/epub+zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation',
];

const TT_SHARE_DOCUMENT_EXTENSIONS = [
    'pdf', 'txt', 'md', 'csv', 'json', 'rtf', 'epub',
    'doc', 'docx', 'odt',
    'xls', 'xlsx', 'ods',
    'ppt', 'pptx', 'odp',
];

/**
 * Where parked shares live.
 *
 * Inside api/var, which is the one directory the container already mounts as a
 * volume, already owns, and already keeps off the document root — the same
 * directory the SQLite file is in, and the same one nothing under /api/ is ever
 * served from.
 */
function tt_share_dir(): string {
    $configured = (string)(getenv('SHARE_DIR') ?: '');
    $base = $configured !== '' ? $configured : __DIR__ . '/var/share';
    if (!is_dir($base)) {
        @mkdir($base, 0700, true);
    }
    return rtrim($base, '/');
}

/** A token is exactly 32 lowercase hex characters, or it is not a token. */
function tt_share_token_is_valid(string $token): bool {
    return preg_match('/^[a-f0-9]{32}$/', $token) === 1;
}

/**
 * Delete every parked share older than the TTL.
 *
 * Run on every request to this endpoint rather than by a cron, because a cron
 * is a thing an operator has to remember to configure and a directory that only
 * grows is a disk that fills. The scan is a readdir of a directory that holds at
 * most a handful of entries — a share is consumed or expires within minutes —
 * so it costs nothing on the path that matters.
 */
function tt_share_sweep(): void {
    $base = tt_share_dir();
    $cutoff = time() - TT_SHARE_TTL_S;
    foreach ((array)@scandir($base) as $entry) {
        if (!is_string($entry) || !tt_share_token_is_valid($entry)) {
            continue;
        }
        $dir = $base . '/' . $entry;
        $meta = $dir . '/meta.json';
        $at = is_file($meta) ? (int)@filemtime($meta) : (int)@filemtime($dir);
        if ($at >= $cutoff) {
            continue;
        }
        tt_share_drop($dir);
    }
}

/** Remove one parked share, directory and all. */
function tt_share_drop(string $dir): void {
    foreach ((array)@scandir($dir) as $entry) {
        if (!is_string($entry) || $entry === '.' || $entry === '..') {
            continue;
        }
        $path = $dir . '/' . $entry;
        if (is_dir($path)) {
            tt_share_drop($path);
        } else {
            @unlink($path);
        }
    }
    @rmdir($dir);
}

/**
 * The name a parked file is stored under, and the one it is served with.
 *
 * Two separate jobs, so two functions. The ON-DISK name is an index and nothing
 * else — never the caller's filename, because a filename is caller-controlled
 * text and a path built from it is a traversal. The SERVED name is for the
 * user's own download dialog, so it is stripped to a conservative character set
 * and capped; it is never used to build a path, and the response is always
 * `application/octet-stream` with `nosniff` whatever it says.
 */
function tt_share_stored_name(int $index): string {
    return sprintf('part-%03d', $index);
}

/**
 * The extensions a served name may keep.
 *
 * An allowlist, and the direction it points matters: this is not "everything
 * except the dangerous ones" but "the ones a file the app can hold actually has".
 * Dropping the extension instead would be simpler and much worse — a downloaded
 * photograph called `shot` with nothing on the end is a file the operating system
 * cannot open and the user cannot rename without thinking about it, and the whole
 * point of serving a name at all is that the download works.
 *
 * A `.php` or a `.html` is therefore not on this list either, even though the
 * response could not execute them: the header is a thing other software reads,
 * and the cheapest way to be sure of what it says is to only ever say one of
 * these.
 */
function tt_share_safe_extension(string $ext): string {
    $safe = array_merge(
        TT_SHARE_DOCUMENT_EXTENSIONS,
        ['jpg', 'jpeg', 'png', 'gif', 'heic', 'webp', 'avif', 'bmp',
         'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', '3gp', 'amr',
         'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi']
    );
    return in_array($ext, $safe, true) ? '.' . $ext : '';
}

function tt_share_served_name(string $name): string {
    $base = basename(str_replace('\\', '/', $name));
    $ext = strtolower((string)pathinfo($base, PATHINFO_EXTENSION));
    $stem = $ext !== '' ? substr($base, 0, -(strlen($ext) + 1)) : $base;
    $clean = preg_replace('/[^A-Za-z0-9._-]/', '_', $stem) ?? '';
    $clean = trim($clean, '._-');
    if ($clean === '') {
        $clean = 'file';
    }
    return substr($clean, 0, 60) . tt_share_safe_extension($ext);
}

/** Is this name and type a document, a picture, a recording or a clip? */
function tt_share_kind(string $type, string $name): ?string {
    $type = strtolower(trim(explode(';', $type)[0]));
    $ext = strtolower((string)pathinfo($name, PATHINFO_EXTENSION));
    if (in_array($type, TT_SHARE_REFUSED_TYPES, true)) {
        return null;
    }
    // An extension that names a document is not rescued by a type that names a
    // script, either: the sender chose both and the closed list is the one that
    // decides.
    if (in_array($ext, ['svg', 'svgz', 'html', 'htm', 'xhtml', 'xml'], true)) {
        return null;
    }
    foreach (TT_SHARE_MEDIA_PREFIXES as $prefix) {
        if (str_starts_with($type, $prefix)) {
            return substr($prefix, 0, -1);
        }
    }
    if (in_array($type, TT_SHARE_DOCUMENT_TYPES, true)
        || in_array($ext, TT_SHARE_DOCUMENT_EXTENSIONS, true)) {
        return 'document';
    }
    return null;
}

/**
 * The multipart boundary, or null when this is not a multipart body.
 *
 * Read out of the Content-Type rather than guessed: a body with a boundary
 * nobody declared is not one this function will parse, and a body whose declared
 * boundary is 200 characters long is not one a person typed.
 */
function tt_share_boundary(string $contentType): ?string {
    $type = strtolower(trim(explode(';', $contentType)[0]));
    if ($type !== 'multipart/form-data') {
        return null;
    }
    if (!preg_match('/boundary="?([^";]+)"?/i', $contentType, $m)) {
        return null;
    }
    $boundary = trim($m[1]);
    // RFC 2046 allows 1–70 characters from a restricted set and nothing else.
    // The check is what makes `explode()` on the boundary below safe to reason
    // about: a caller cannot declare a one-character boundary and have every
    // part boundary out of the parse.
    if ($boundary === '' || strlen($boundary) > 70 || preg_match('/[^0-9A-Za-z\'()+\-_,./:=? ]/', $boundary)) {
        return null;
    }
    return $boundary;
}

/**
 * The Content-Disposition of a part, or "" when the part has none.
 *
 * Read on its own line rather than out of the whole header block, because the
 * two things a part carries are spelled differently and reading them from one
 * blob is how they get confused: a parameter (`name="f"`, `filename="f.pdf"`)
 * belongs to Content-Disposition, and a type (`Content-Type: image/png`) is a
 * header of its own. A single regex over the block found the `name=` inside
 * `filename=` — every image and every recording was then filed under a name that
 * is not one of the field names, and silently dropped.
 */
function tt_share_part_disposition(string $headers): string {
    foreach (preg_split('/\r\n|\n/', $headers) ?: [] as $line) {
        if (stripos($line, 'Content-Disposition:') === 0) {
            return trim(substr($line, strlen('Content-Disposition:')));
        }
    }
    return '';
}

/**
 * The Content-Type of a part, or "" when it declared none.
 *
 * A browser sends it for a file part; a hand-built body may not, and then the
 * extension is the only thing left to classify by. Which is why
 * tt_share_kind() takes both and why the document allowlist is a list of
 * extensions as well as a list of types.
 */
function tt_share_part_type(string $headers): string {
    foreach (preg_split('/\r\n|\n/', $headers) ?: [] as $line) {
        if (stripos($line, 'Content-Type:') === 0) {
            return trim(substr($line, strlen('Content-Type:')));
        }
    }
    return '';
}

/**
 * One Content-Disposition parameter.
 *
 * RFC 5987 form: the parameter may arrive as `filename*=UTF-8''f%C3%A9` (which is
 * how a non-ASCII filename reaches a browser), as `filename="f"`, or with no
 * quotes at all. All three are read, and the extended form is decoded — with a
 * length cap and control characters removed, because this is attacker-controlled
 * text that is about to be written into a response header.
 *
 * The `(?<![-\w])` guard is not decoration. Without it, asking for `name` in a
 * disposition that also carries `filename` finds the `name=` inside `filename=`
 * and returns the filename as the field name.
 */
function tt_share_part_param(string $disposition, string $key): ?string {
    $quoted = preg_quote($key, '/');
    if (!preg_match('/(?<![-\w])' . $quoted . '\*?=(?:"([^"]*)"|([^;\s]+))/i', $disposition, $m)) {
        return null;
    }
    $value = ($m[1] ?? '') !== '' ? $m[1] : ($m[2] ?? '');
    if (preg_match('/(?<![-\w])' . $quoted . '\*=/i', $disposition) && str_contains($value, "''")) {
        $parts = explode("''", $value, 2);
        $value = rawurldecode($parts[1] ?? '');
    }
    $value = str_replace(["\r", "\n", "\0"], '', $value);
    return substr($value, 0, 200);
}

/**
 * The body of a request, read once, with the ceiling applied as it is read.
 *
 * The declared Content-Length is refused BEFORE the read (a caller that says it
 * is sending 400 MB never gets 400 MB allocated), and the actual bytes read are
 * counted too — a lying Content-Length is the one way past the first check.
 */
function tt_share_body(int $maxBytes): ?string {
    $declared = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($declared > $maxBytes) {
        tt_error(413, 'payload_too_large');
    }
    $in = fopen('php://input', 'rb');
    if ($in === false) {
        return null;
    }
    $body = '';
    $room = $maxBytes + 1;   // one byte past the ceiling, so "too big" is detectable
    while (!feof($in) && strlen($body) <= $maxBytes) {
        $chunk = fread($in, 65536);
        if ($chunk === false || $chunk === '') {
            break;
        }
        $body .= $chunk;
    }
    fclose($in);
    if (strlen($body) > $maxBytes) {
        tt_error(413, 'payload_too_large');
    }
    return $body;
}

/**
 * Park a shared body and answer with the URL the app is sent to.
 *
 * Written to a fresh random directory, and the metadata file — which is what
 * `tt_share_sweep` reads the age from — is written LAST, so a directory that
 * exists is a directory that was finished. A crash halfway leaves an empty
 * directory with no meta.json, and the sweep still collects it: an unreadable
 * age is treated as old rather than as new, because the alternative is a
 * half-written share that nothing ever cleans up.
 */
function tt_share_intake_post(): void {
    $cfg = task_timer_config();
    tt_share_sweep();

    $contentType = (string)($_SERVER['CONTENT_TYPE'] ?? '');
    $boundary = tt_share_boundary($contentType);
    if ($boundary === null) {
        // Not a multipart body. Either the browser sent a GET-style share (the
        // manifest before this feature, or a browser that ignores `files`), or
        // the SAPI consumed the body because enable_post_data_reading is on.
        // Both are answered the same way, and the client falls back.
        tt_error(415, 'share_intake_unavailable');
    }

    $maxBytes = (int)$cfg['share_intake_max_bytes'];
    $body = tt_share_body($maxBytes);
    if ($body === null || $body === '') {
        tt_error(415, 'share_intake_unavailable');
    }

    // Split on the boundary. RFC 2046 requires the sender to choose a boundary
    // that does not occur in the content, and the only sender here is a browser
    // that generates it at random per request, so `explode` is a complete parse
    // rather than an approximation of one. The limit above is what keeps a
    // hand-crafted body from making this expensive.
    $segments = explode('--' . $boundary, $body);
    array_shift($segments);   // the preamble, which is by definition ignorable

    $fields = [];
    $files = [];
    $skipped = 0;
    $seen = 0;

    foreach ($segments as $segment) {
        if ($segment === '' || str_starts_with($segment, '--')) {
            break;   // the epilogue, and the end of the body
        }
        // Every delimiter is preceded by CRLF, which belongs to the delimiter.
        $segment = substr($segment, 0, 2) === "\r\n" ? substr($segment, 2) : $segment;
        $split = strpos($segment, "\r\n\r\n");
        if ($split === false) {
            $skipped++;
            continue;
        }
        $headers = substr($segment, 0, $split);
        $content = substr($segment, $split + 4);
        // …and the CRLF before the next delimiter belongs to that delimiter.
        if (substr($content, -2) === "\r\n") {
            $content = substr($content, 0, -2);
        }
        $disposition = tt_share_part_disposition($headers);
        $name = tt_share_part_param($disposition, 'name') ?? '';
        if ($name === '') {
            $skipped++;
            continue;
        }

        if (in_array($name, TT_SHARE_FIELDS, true)) {
            // A text field is capped hard: it ends up in a record, and a record
            // has its own limits that would otherwise be the only defence.
            if (strlen($content) > 4096) {
                $skipped++;
                continue;
            }
            $fields[$name] = trim($content);
            continue;
        }

        if (!in_array($name, TT_SHARE_FILE_FIELDS, true)) {
            $skipped++;
            continue;
        }

        // A file part. The kind decides whether it is stored at all, and an
        // empty part is a part the user did not choose anything for.
        $filename = tt_share_part_param($disposition, 'filename') ?? '';
        $declared = tt_share_part_type($headers);
        $kind = $filename === '' ? null : tt_share_kind($declared, $filename);
        $size = strlen($content);
        if ($kind === null || $size === 0) {
            $skipped++;
            continue;
        }
        if (count($files) >= (int)$cfg['share_intake_max_files']) {
            $skipped++;
            continue;
        }
        $files[] = [
            'kind' => $kind,
            // The name as the sender wrote it, for the record the app will make.
            // It is not used as a path and not used as a response header
            // verbatim; tt_share_served_name() is what reaches the wire.
            'name' => substr(basename(str_replace('\\', '/', $filename)), 0, 200),
            'type' => substr($declared, 0, 120),
            'size' => $size,
            'stored' => tt_share_stored_name($seen),
        ];
        $seen++;
        // Held in memory as well as in the list; the whole body is already in
        // memory, so this is a copy of a byte range rather than a second read.
        $files[count($files) - 1]['bytes'] = $content;
    }

    if (!$files && !array_filter($fields, static fn($v) => $v !== '')) {
        // Nothing usable in it. A share with no text and no file is not a share,
        // and parking it would hand the app an empty chooser to show.
        tt_error(400, 'share_intake_empty');
    }

    $token = bin2hex(random_bytes(16));
    $dir = tt_share_dir() . '/' . $token;
    if (!@mkdir($dir, 0700, true)) {
        // Not an internal error: this is a deployment that cannot hold a parked
        // share (a read-only api/var, a volume that is not mounted, a host whose
        // temp dir is somewhere PHP may not write). It gets the same code as the
        // missing-ini case, because the client's answer to it is the same — fall
        // back to the attachment picker — and a user who sees a generic failure
        // has nowhere to go from it.
        error_log('[task-timer-share] cannot create the park directory: ' . tt_share_dir());
        tt_error(503, 'share_intake_unavailable');
    }
    foreach ($files as $i => $file) {
        // 0600 and a name of our own: the file is never readable by another
        // account on the box, and never reachable by a path a caller chose.
        if (@file_put_contents($dir . '/' . $file['stored'], $file['bytes'], LOCK_EX) === false) {
            tt_share_drop($dir);
            tt_error(500, 'internal');
        }
        unset($files[$i]['bytes']);
    }
    $meta = [
        'at' => time(),
        'fields' => $fields,
        'files' => $files,
        'skipped' => $skipped,
    ];
    if (@file_put_contents($dir . '/meta.json', json_encode($meta), LOCK_EX) === false) {
        tt_share_drop($dir);
        tt_error(500, 'internal');
    }

    // 303, not 302: the browser must issue the follow-up as a GET. A 302 after a
    // POST is followed with a POST by some clients and a GET by others, and the
    // one that repeats the POST would re-upload the file.
    http_response_code(303);
    header('Location: /share?t=' . $token);
    tt_share_intake_headers();
    header('Cache-Control: no-store');
    exit;
}

/**
 * The metadata of a parked share, as JSON.
 *
 * `t` is the whole authorisation: a 128-bit random value that is good for ten
 * minutes, with no cookie and no session involved. That is deliberate — a share
 * can arrive before the app has ever been opened on this device, so there is no
 * session to check — and it is why the token is never in a URL the app renders
 * into a link, never cached, and never guessable.
 */
function tt_share_intake_meta(): void {
    tt_share_sweep();
    $token = (string)($_GET['t'] ?? '');
    if (!tt_share_token_is_valid($token)) {
        tt_error(400, 'bad_request');
    }
    $dir = tt_share_dir() . '/' . $token;
    $metaFile = $dir . '/meta.json';
    if (!is_file($metaFile)) {
        tt_error(404, 'share_intake_gone');
    }
    $meta = json_decode((string)@file_get_contents($metaFile), true);
    if (!is_array($meta)) {
        tt_share_drop($dir);
        tt_error(404, 'share_intake_gone');
    }
    $fields = is_array($meta['fields'] ?? null) ? $meta['fields'] : [];
    $files = is_array($meta['files'] ?? null) ? $meta['files'] : [];
    $out = [];
    foreach ($files as $i => $file) {
        $out[] = [
            'kind' => (string)($file['kind'] ?? 'document'),
            'name' => (string)($file['name'] ?? 'file'),
            'type' => (string)($file['type'] ?? ''),
            'size' => (int)($file['size'] ?? 0),
            // The bytes are a SEPARATE request, and a separate request is what
            // keeps this one small: a five-megabyte clip is 6.7 MB of base64 in
            // one JSON document and about 1 KB here.
            'url' => '/api/share/intake?t=' . $token . '&i=' . (int)$i,
        ];
    }
    tt_json(200, [
        'ok' => true,
        'title' => substr((string)($fields['title'] ?? ''), 0, 300),
        'text' => substr((string)($fields['text'] ?? ''), 0, 2000),
        'url' => substr((string)($fields['url'] ?? ''), 0, 2000),
        'files' => $out,
        'skipped' => (int)($meta['skipped'] ?? 0),
    ]);
}

/**
 * One parked file's bytes.
 *
 * `application/octet-stream` and `nosniff` whatever the sender claimed the file
 * was, and `attachment` so it is never rendered in this origin. This is the one
 * place in the app where caller-supplied bytes are served back over HTTP, and it
 * is the one place a stored XSS would live if the content type were believed:
 * an uploaded .html or .svg with `text/html` on this origin is a script running
 * with the app's origin, and the whole point of the document allowlist is that
 * the app never wants such a file — but the response has to be safe whether or
 * not the allowlist was right.
 */
function tt_share_intake_part(): void {
    $token = (string)($_GET['t'] ?? '');
    $index = $_GET['i'] ?? '';
    if (!tt_share_token_is_valid($token) || !preg_match('/^\d{1,2}$/', (string)$index)) {
        tt_error(400, 'bad_request');
    }
    $dir = tt_share_dir() . '/' . $token;
    $metaFile = $dir . '/meta.json';
    if (!is_file($metaFile)) {
        tt_error(404, 'share_intake_gone');
    }
    $meta = json_decode((string)@file_get_contents($metaFile), true);
    $file = is_array($meta) ? ($meta['files'][(int)$index] ?? null) : null;
    if (!is_array($file)) {
        tt_error(404, 'share_intake_gone');
    }
    $path = $dir . '/' . tt_share_stored_name((int)$index);
    $real = realpath($path);
    // A second, filesystem-level check that the part is inside its own
    // directory. The stored name is a formatted integer, so this cannot fail —
    // which is exactly why it is cheap and why it is here.
    if ($real === false || !str_starts_with($real, realpath($dir) . DIRECTORY_SEPARATOR)) {
        tt_error(404, 'share_intake_gone');
    }
    $size = (int)filesize($real);
    http_response_code(200);
    tt_share_intake_headers();
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . tt_share_served_name((string)($file['name'] ?? 'file')) . '"');
    header('Cache-Control: no-store');
    header('Content-Length: ' . (string)$size);
    readfile($real);
    exit;
}

/** Forget a parked share without reading it. */
function tt_share_intake_delete(): void {
    $token = (string)($_GET['t'] ?? '');
    if (!tt_share_token_is_valid($token)) {
        tt_error(400, 'bad_request');
    }
    $dir = tt_share_dir() . '/' . $token;
    if (is_dir($dir)) {
        tt_share_drop($dir);
    }
    tt_json(200, ['ok' => true]);
}

/**
 * The headers on a share response.
 *
 * The API's own security headers, without the Content-Security-Policy: this
 * response is either a 303 to a page in the app or a download, never a
 * document, and the app's CSP is emitted by whatever serves /share. Sending a
 * second, different CSP here would be a policy nothing is measured against.
 */
function tt_share_intake_headers(): void {
    header_remove('X-Powered-By');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: no-referrer');
}
