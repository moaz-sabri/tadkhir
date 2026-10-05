<?php

declare(strict_types=1);

/**
 * The share intake, tested from the attacker's side.
 *
 * A Web Share Target is the one part of this app a person triggers without
 * opening it, and the one part that is a FORM POST to an endpoint that needs no
 * session. That combination is the whole reason this file exists: everything here
 * is a property somebody outside the app depends on, and each one is stated and
 * then broken with a hand-built multipart body rather than through the client,
 * because the client is not what reaches this endpoint.
 *
 * The bodies are assembled byte by byte here on purpose. A helper that used
 * PHP's own multipart encoder would only ever produce the well-formed shape, and
 * every interesting case is the malformed one: a boundary that appears inside a
 * file, a filename with a traversal in it, a part whose type is text/html.
 */

const SHARE_BOUNDARY = '----TadkhirShareTestBoundary7d3f';

/**
 * One multipart part. `$filename` null means a plain field.
 */
function share_part(string $name, string $content, ?string $type = null, ?string $filename = null): string {
    $headers = "Content-Disposition: form-data; name=\"$name\"";
    if ($filename !== null) {
        $headers .= "; filename=\"$filename\"";
    }
    if ($type !== null) {
        $headers .= "\r\nContent-Type: $type";
    }
    return "--" . SHARE_BOUNDARY . "\r\n" . $headers . "\r\n\r\n" . $content . "\r\n";
}

/** A whole multipart body from a list of already-built parts. */
function share_body(array $parts): string {
    return implode('', $parts) . '--' . SHARE_BOUNDARY . "--\r\n";
}

/**
 * A request that does not assume the answer is JSON.
 *
 * The shared harness decodes every body as JSON, which is right for the sync API
 * and useless here: half of what this endpoint returns is a photograph. So this
 * posts raw bytes and hands back the raw body plus the headers, and every
 * assertion below is written against those.
 */
function share_request(string $method, string $path, string $content = '', array $headers = []): array {
    global $port;
    $lines = [];
    foreach ($headers as $name => $value) {
        $lines[] = "$name: $value";
    }
    if ($content !== '' && !isset($headers['Content-Type'])) {
        $lines[] = 'Content-Type: application/json';
    }
    $ctx = stream_context_create([
        'http' => [
            'method'        => $method,
            'header'        => implode("\r\n", $lines),
            'content'       => $content,
            'ignore_errors' => true,
            'timeout'       => 20,
            // THE point of a raw request here. PHP's HTTP stream wrapper follows
            // 3xx by default, so the 303 this endpoint answers with would be
            // consumed here and the token would never reach the assertion — every
            // test would then be reading a 404 from a path that is not even the
            // API. The redirect IS the answer, so it must not be followed.
            'follow_location' => 0,
            'max_redirects'   => 0,
        ],
    ]);
    $raw = @file_get_contents('http://127.0.0.1:' . $port . $path, false, $ctx);
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $m)) {
            $status = (int)$m[1];
            break;
        }
    }
    return [
        'status'  => $status,
        'raw'     => $raw === false ? '' : $raw,
        // 'body' and 'json' are the same value under both names on purpose: the
        // shared sec_error_code() helper reads `body`, and a test that decoded
        // its answer under a name that helper does not know would compare every
        // error code against "" and pass for the wrong reason.
        'body'    => $raw === false ? null : json_decode($raw, true),
        'json'    => $raw === false ? null : json_decode($raw, true),
        'headers' => $http_response_header ?? [],
    ];
}

/** The token out of a 303's Location, or "" when the answer was not one. */
function share_token(array $res): string {
    foreach ($res['headers'] as $h) {
        if (stripos($h, 'Location:') === 0) {
            $location = trim(substr($h, strlen('Location:')));
            if (preg_match('#/share\?t=([a-f0-9]{32})$#', $location, $m)) {
                return $m[1];
            }
        }
    }
    return '';
}

function share_multipart(string $body): array {
    return ['Content-Type' => 'multipart/form-data; boundary=' . SHARE_BOUNDARY];
}

/**
 * A park directory for one test, created when the test RUNS.
 *
 * Not at registration. `sec_it` receives its environment as a value, so a
 * directory chosen while the test was being registered would be the LAST one
 * registered by the time any test executed — every test would then inspect a
 * directory no server was using, and the traversal and boundary tests would
 * pass for the wrong reason. So the registrar below makes the directory at run
 * time, hands it to the server as SHARE_DIR, and leaves it in a global for the
 * assertions that need to look at the disk.
 */
$GLOBALS['tt_share_dir'] = null;

function share_register(string $name, array $env, callable $fn): void {
    it($name, function () use ($name, $env, $fn) {
        $dir = sys_get_temp_dir() . '/tt-share-' . bin2hex(random_bytes(4));
        @mkdir($dir, 0700, true);
        $GLOBALS['tt_share_dir'] = $dir;
        // The same boot every other security group gets, with SHARE_DIR added.
        sec_server($name, $env + ['SHARE_DIR' => $dir]);
        try {
            $fn();
        } finally {
            // The parked bytes are the test's own scratch space; leaving a few
            // megabytes in the temp directory per run is not a courtesy.
            foreach ((array)@scandir($dir) as $entry) {
                if (is_string($entry) && $entry !== '.' && $entry !== '..') {
                    @unlink($dir . '/' . $entry);
                }
            }
            @rmdir($dir);
        }
    });
}

/** The directory the current test told its server to park shares in. */
function share_dir(): string {
    $dir = (string)$GLOBALS['tt_share_dir'];
    assertTrue(is_dir($dir), 'the park directory exists');
    return $dir;
}

/* ================== THE HAPPY PATH ======================================= */

share_register('share: a text share is parked and answered with a 303 to the chooser', [], function () {
    $body = share_body([
        share_part('title', 'How timers work'),
        share_part('text', 'read this on the train'),
        share_part('url', 'https://example.com/article'),
    ]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));

    // 303 and not 302: the browser must follow up with a GET. A 302 after a POST
    // is reissued as a POST by some clients, which would upload the file again.
    assertSame($res['status'], 303, 'a parked share redirects');
    $token = share_token($res);
    assertTrue($token !== '', 'the redirect carries a 32-hex token: ' . json_encode($res['headers']));
    // The token is the whole authorisation, so it must not be something a caller
    // chose: 128 random bits, never a session id, never a counter.
    assertTrue(!str_contains($token, 'tt_session'), 'the token is not a session');

    $meta = share_request('GET', '/api/share/intake?t=' . $token);
    assertSame($meta['status'], 200, 'the parked share reads back');
    assertSame($meta['json']['title'], 'How timers work', 'the title survives');
    assertSame($meta['json']['text'], 'read this on the train', 'the text survives');
    assertSame($meta['json']['url'], 'https://example.com/article', 'the url survives');
    assertSame($meta['json']['files'], [], 'a text share has no files');
    assertSame($meta['json']['ok'], true, 'the envelope is ok');
});

share_register('share: a file comes back byte for byte, and as octet-stream', [], function () {
    // Binary, including a NUL and a CRLF — the two things a body assembled as
    // text would mangle and the two a real photograph is full of.
    $bytes = "\x89PNG\r\n\x1a\n" . random_bytes(2048) . "\r\n\x00trailing";
    $body = share_body([
        share_part('title', 'A whiteboard'),
        share_part('files', $bytes, 'image/png', 'IMG_0042.png'),
    ]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    $token = share_token($res);
    assertTrue($token !== '', 'the share was parked');

    $meta = share_request('GET', '/api/share/intake?t=' . $token);
    assertSame(count($meta['json']['files']), 1, 'one file is described');
    $file = $meta['json']['files'][0];
    assertSame($file['kind'], 'image', 'a png is a photo');
    assertSame($file['name'], 'IMG_0042.png', 'the name the sender chose is kept');
    assertSame($file['size'], strlen($bytes), 'the size is the byte count');

    // The bytes are a SEPARATE request. That is what keeps the metadata small: a
    // 5 MB clip is 6.7 MB of base64 in one JSON document and about 200 bytes here.
    $part = share_request('GET', $file['url']);
    assertSame($part['status'], 200, 'the part is served');
    assertSame(strlen($part['raw']), strlen($bytes), 'every byte came back');
    assertTrue($part['raw'] === $bytes, 'the bytes are identical, NUL and CRLF included');

    // The one place in the app where caller-supplied bytes are served over HTTP.
    // Believing the sender's content type here would be a stored XSS with the
    // app's own origin, so the answer is octet-stream, an attachment disposition
    // and nosniff — whatever the file claimed to be.
    assertSame(sec_header($part, 'Content-Type'), 'application/octet-stream',
        'the bytes are never served as the type the sender claimed');
    assertSame(sec_header($part, 'X-Content-Type-Options'), 'nosniff', 'nosniff on the bytes');
    assertTrue(stripos(sec_header($part, 'Content-Disposition'), 'attachment') === 0,
        'the bytes are an attachment, never rendered in this origin');
    assertTrue(stripos(sec_header($part, 'Cache-Control'), 'no-store') === 0,
        'a parked share is never stored by a cache');
});

share_register('share: several files of different kinds are all kept', [], function () {
    $body = share_body([
        share_part('text', 'the receipt and the whiteboard'),
        share_part('files', 'PNG-ISH', 'image/png', 'shot.png'),
        share_part('files', 'PDF-ISH', 'application/pdf', 'receipt.pdf'),
        share_part('files', 'WEBMAUDIO', 'audio/webm', 'memo.webm'),
    ]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    $meta = share_request('GET', '/api/share/intake?t=' . share_token($res));
    $kinds = array_column($meta['json']['files'], 'kind');
    assertSame($kinds, ['image', 'document', 'audio'], 'each file is classified, none is dropped');
});

/* ================== WHAT IT REFUSES ====================================== */

share_register('share: a type the app cannot hold is dropped, and the rest survives', [], function () {
    // The whole share is NOT refused. A user who selected a photograph and an
    // .html has lost the photograph if the answer is an error, and the .html was
    // never going to be stored either way.
    $body = share_body([
        share_part('text', 'keep the picture'),
        share_part('files', '<script>alert(1)</script>', 'text/html', 'evil.html'),
        share_part('files', 'GIF89a', 'image/gif', 'ok.gif'),
    ]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    $meta = share_request('GET', '/api/share/intake?t=' . share_token($res));
    assertSame(count($meta['json']['files']), 1, 'only the file the app can hold is kept');
    assertSame($meta['json']['files'][0]['name'], 'ok.gif', 'and it is the right one');
    assertSame($meta['json']['skipped'], 1, 'the refusal is reported, not hidden');
    assertSame($meta['json']['text'], 'keep the picture', 'the text is untouched');
});

share_register('share: an svg is not a document here', [], function () {
    // SVG is a document type in every other sense and a script in one, so it is
    // absent from the allowlist on purpose. Same for anything html-shaped.
    foreach (['image/svg+xml', 'text/html', 'application/xhtml+xml'] as $type) {
        $body = share_body([share_part('files', '<svg onload=alert(1)>', $type, 'x.svg')]);
        $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
        // Nothing usable in it at all, so there is nothing to park.
        assertSame($res['status'], 400, "$type is refused outright");
    }
});

share_register('share: a filename cannot escape the park directory', [], function () {
    $dir = share_dir();
    $body = share_body([
        share_part('text', 'traversal'),
        // The name is kept for the record, so the traversal has to be stripped
        // there too — and the file on disk is a formatted index, never this.
        share_part('files', 'GIF89a', 'image/gif', '../../../../etc/passwd.png'),
    ]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    assertSame($res['status'], 303, 'the share is parked');
    $token = share_token($res);

    $meta = share_request('GET', '/api/share/intake?t=' . $token);
    assertSame($meta['json']['files'][0]['name'], 'passwd.png', 'the directory part is gone from the name');

    // The decisive assertion: the ONLY files under the park directory are the
    // index and the metadata, and nothing exists above it.
    $found = array_values(array_diff(scandir($dir . '/' . $token), ['.', '..']));
    sort($found);
    assertSame($found, ['meta.json', 'part-000'], 'the bytes are stored under a name of our own');
    assertTrue(!file_exists(dirname($dir) . '/passwd.png'), 'nothing was written outside the park');
});

share_register('share: a filename with a quote cannot break the response header', [], function () {
    $body = share_body([
        share_part('files', '%PDF-1.4', 'application/pdf', 'a"b\r\nX-Evil: 1.pdf'),
    ]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    $meta = share_request('GET', '/api/share/intake?t=' . share_token($res));
    $part = share_request('GET', $meta['json']['files'][0]['url']);
    $disposition = sec_header($part, 'Content-Disposition');
    assertTrue(!str_contains($disposition, 'X-Evil'),
        'a header cannot be injected through a filename: ' . $disposition);
    assertTrue(preg_match('/^attachment; filename="[A-Za-z0-9._-]+"$/i', $disposition) === 1,
        'the served filename is a conservative character set: ' . $disposition);

    // …and it keeps the extension, because a download named `receipt` with
    // nothing on the end is a file nothing can open. The list it may keep from
    // is an allowlist of what a file the app can hold actually has, so `.php`
    // and `.html` are not among them.
    $ok = share_body([share_part('files', 'GIF89a', 'image/gif', 'shot.gif')]);
    $token = share_token(share_request('POST', '/api/share/intake', $ok, share_multipart($ok)));
    $good = share_request('GET', share_request('GET', '/api/share/intake?t=' . $token)['json']['files'][0]['url']);
    assertTrue(str_contains(sec_header($good, 'Content-Disposition'), 'shot.gif'),
        'a real extension survives: ' . sec_header($good, 'Content-Disposition'));

    $php = share_body([share_part('files', '<?php', 'image/gif', 'shell.php')]);
    $phpToken = share_token(share_request('POST', '/api/share/intake', $php, share_multipart($php)));
    $phpPart = share_request('GET', share_request('GET', '/api/share/intake?t=' . $phpToken)['json']['files'][0]['url']);
    assertTrue(!str_contains(sec_header($phpPart, 'Content-Disposition'), '.php'),
        'a script extension never reaches a header: ' . sec_header($phpPart, 'Content-Disposition'));
});

share_register('share: a body over the ceiling is refused, and the ceiling is its own', ['SHARE_MAX_BYTES' => '65536'], function () {
    // 96 KiB against a 64 KiB ceiling. The API's own REQUEST_MAX_BYTES is 1 MiB
    // and is deliberately not what applies here — a share is expected to be
    // larger than a JSON push — so the test pins that the endpoint answers with
    // ITS limit rather than the general one.
    $body = share_body([share_part('files', str_repeat('A', 96 * 1024), 'image/png', 'big.png')]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    assertSame($res['status'], 413, 'an oversized share is refused');
    assertSame(sec_error_code($res), 'payload_too_large', 'and says so in the API vocabulary');
});

share_register('share: a body under the intake ceiling is accepted even past REQUEST_MAX_BYTES', ['REQUEST_MAX_BYTES' => '2048', 'SHARE_MAX_BYTES' => '4194304'], function () {
    // The point of the separate ceiling, asserted: 512 KiB of photograph is fine
    // here while the whole rest of the API would refuse a 2 KiB body. If this ever
    // regressed to inheriting request_max_bytes, sharing a photo would break.
    $body = share_body([share_part('files', str_repeat('B', 512 * 1024), 'image/png', 'ok.png')]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    assertSame($res['status'], 303, 'a share larger than REQUEST_MAX_BYTES still lands');
    $meta = share_request('GET', '/api/share/intake?t=' . share_token($res));
    assertSame($meta['json']['files'][0]['size'], 512 * 1024, 'and comes back whole');

    // …while the JSON API is still held to its own, much smaller, limit. The
    // body has to be genuinely over 2 KiB, and the endpoint has to be one that
    // reads a body: an unauthenticated pull is refused with 401 before the
    // ceiling is even consulted, which would make this assertion true for the
    // wrong reason.
    $json = share_request('POST', '/api/auth/open', json_encode([
        'code' => 'x', 'password' => str_repeat('p', 4096), 'device' => ['id' => 'd'],
    ]), ['Content-Type' => 'application/json']);
    assertSame($json['status'], 413, 'the rest of the API keeps its own 2 KiB ceiling in this group');
    assertSame(sec_error_code($json), 'payload_too_large', 'and says so in the API vocabulary');
});

share_register('share: more files than the ceiling are skipped, and the share still lands', ['SHARE_MAX_FILES' => '2'], function () {
    $parts = [share_part('text', 'too many')];
    for ($i = 0; $i < 5; $i++) {
        $parts[] = share_part('files', 'GIF89a' . $i, 'image/gif', "shot$i.gif");
    }
    $body = share_body($parts);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    $meta = share_request('GET', '/api/share/intake?t=' . share_token($res));
    assertSame(count($meta['json']['files']), 2, 'the cap is the cap');
    assertSame($meta['json']['skipped'], 3, 'the rest are reported as skipped');
});

/* ================== THE ENVELOPE ========================================= */

share_register('share: a non-multipart POST is refused, and says which case it is', [], function () {
    // Three different situations land here — a browser that ignores the file
    // share target, a browser posting something else entirely, and a server
    // whose SAPI consumed the body because enable_post_data_reading is on. The
    // client needs to tell the third one apart, because that is the one an
    // operator can fix, so the code is specific rather than a generic 415.
    $json = share_request('POST', '/api/share/intake', json_encode(['text' => 'x']), ['Content-Type' => 'application/json']);
    assertSame($json['status'], 415, 'a JSON body is not a share');
    assertSame(sec_error_code($json), 'share_intake_unavailable', 'and the client can act on it');

    $form = share_request('POST', '/api/share/intake', 'text=x', ['Content-Type' => 'application/x-www-form-urlencoded']);
    assertSame(sec_error_code($form), 'share_intake_unavailable', 'a urlencoded body is not a share either');

    // A multipart body with no boundary in the Content-Type is unparseable, and
    // guessing a boundary is how a parser ends up inventing one.
    $noBoundary = share_request('POST', '/api/share/intake', 'x', ['Content-Type' => 'multipart/form-data']);
    assertSame(sec_error_code($noBoundary), 'share_intake_unavailable', 'a multipart body with no boundary is refused');

    // An over-long declared boundary is refused before it is used as a delimiter.
    $long = str_repeat('z', 200);
    $weird = share_request('POST', '/api/share/intake', 'x', ['Content-Type' => "multipart/form-data; boundary=$long"]);
    assertSame(sec_error_code($weird), 'share_intake_unavailable', 'an 80-character boundary is refused');
});

share_register('share: an empty share is refused rather than parked', [], function () {
    $body = share_body([share_part('text', '   ')]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    assertSame($res['status'], 400, 'nothing usable in it is not a share');
    assertSame(sec_error_code($res), 'share_intake_empty', 'and it says so');
});

share_register('share: a token is the only key, and a guessed one gets nothing', [], function () {
    // A well-formed but wrong token is a 404 and a malformed one is a 400, both
    // without touching the disk. There is no cookie and no session to fall back
    // on: a share can arrive before the app has ever been opened here, which is
    // exactly why the token is 128 random bits and nothing else.
    $body = share_body([share_part('text', 'secret')]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    $token = share_token($res);

    foreach ([str_repeat('a', 31), str_repeat('A', 32), str_repeat('g', 32), 'short', '../../etc', ''] as $guess) {
        $bad = share_request('GET', '/api/share/intake?t=' . rawurlencode($guess));
        assertSame($bad['status'], 400, 'a malformed token is a bad request: ' . $guess);
    }
    $missing = share_request('GET', '/api/share/intake?t=' . str_repeat('0', 32));
    assertSame($missing['status'], 404, 'a well-formed token that was never issued is a 404');
    assertSame(sec_error_code($missing), 'share_intake_gone', 'and says the share is gone');

    // No token at all.
    assertSame(share_request('GET', '/api/share/intake')['status'], 400, 'no token is a bad request');
    // The real one still works, so the refusals above are refusals and not a
    // broken endpoint.
    assertSame(share_request('GET', '/api/share/intake?t=' . $token)['status'], 200, 'the issued token works');
});

share_register('share: a part index cannot reach outside the parked files', [], function () {
    $body = share_body([share_part('text', 'one file'), share_part('files', 'GIF89a', 'image/gif', 'a.gif')]);
    $token = share_token(share_request('POST', '/api/share/intake', $body, share_multipart($body)));
    foreach (['1.0', 'a', '', '-1', 'x9', '9x', '1e2', '+1', ' 1'] as $i) {
        $res = share_request('GET', '/api/share/intake?t=' . $token . '&i=' . rawurlencode($i));
        assertSame($res['status'], 400, "index \"$i\" is not an index");
    }
    // A zero-padded index is index zero, not a second way of naming something
    // else: it has to serve the same bytes as `i=0` and nothing beyond them.
    $padded = share_request('GET', '/api/share/intake?t=' . $token . '&i=00');
    assertSame($padded['status'], 200, 'i=00 is i=0');
    assertSame($padded['raw'], share_request('GET', '/api/share/intake?t=' . $token . '&i=0')['raw'],
        'and it is the same file');
    // Out of range but well formed: a 404, and never a file from a different
    // share, because the on-disk name is derived from the index and the metadata
    // is read from the same directory.
    $miss = share_request('GET', '/api/share/intake?t=' . $token . '&i=7');
    assertSame($miss['status'], 404, 'an index past the end is a 404');
});

share_register('share: DELETE forgets a parked share, and the token stops working', [], function () {
    $body = share_body([share_part('text', 'discard me')]);
    $token = share_token(share_request('POST', '/api/share/intake', $body, share_multipart($body)));
    assertSame(share_request('GET', '/api/share/intake?t=' . $token)['status'], 200, 'it is there to begin with');

    $del = share_request('DELETE', '/api/share/intake?t=' . $token);
    assertSame($del['status'], 200, 'the release succeeds');
    assertSame(share_request('GET', '/api/share/intake?t=' . $token)['status'], 404, 'and it is gone');
    // Releasing twice is not an error: the client fires it without awaiting and
    // the sweeper may have got there first.
    assertSame(share_request('DELETE', '/api/share/intake?t=' . $token)['status'], 200, 'a second release is fine');
});

share_register('share: the other verbs are 405 with an Allow header', [], function () {
    foreach (['PUT', 'PATCH'] as $method) {
        $res = share_request($method, '/api/share/intake', 'x', ['Content-Type' => 'text/plain']);
        assertSame($res['status'], 405, "$method is not accepted");
        assertTrue(str_contains(sec_header($res, 'Allow'), 'POST'), 'the Allow header says what is');
    }
});

share_register('share: a boundary that also appears inside a file is not a mis-parse', [], function () {
    // RFC 2046 requires a sender to pick a boundary that does not occur in the
    // content, and the only sender here is a browser that generates it at random
    // per request. A file that CONTAINS the delimiter is a hand-built body, and
    // what matters is that it cannot be made to overwrite another part: the
    // stored name comes from the counter, not from anything in the body.
    $body = share_body([
        share_part('text', 'delimiter inside'),
        share_part('files', 'GIF89a' . "\r\n--" . SHARE_BOUNDARY . "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"sneaky.gif\"\r\n\r\nowned", 'image/gif', 'real.gif'),
    ]);
    $res = share_request('POST', '/api/share/intake', $body, share_multipart($body));
    $token = share_token($res);
    $meta = share_request('GET', '/api/share/intake?t=' . $token);
    // Whatever the split produced, the served bytes are served from a file named
    // part-000 and the directory holds nothing else.
    $found = array_values(array_diff(scandir(share_dir() . '/' . $token), ['.', '..']));
    sort($found);
    assertSame($found, ['meta.json', 'part-000'], 'no part invented a file of its own');
});

/* ================== WHAT IT DOES NOT TOUCH ============================== */

share_register('share: the intake writes nothing into the records database', [], function () {
    // A share is not a record until the user chooses a destination, and the
    // endpoint has no session to attribute one to. So the sync tables must be
    // exactly as empty as they were before it.
    $pdo = sec_db();
    $before = (int)$pdo->query('SELECT COUNT(*) FROM records')->fetchColumn();
    $body = share_body([
        share_part('text', 'a link and a picture'),
        share_part('url', 'https://example.com/a'),
        share_part('files', 'GIF89a', 'image/gif', 'a.gif'),
    ]);
    share_request('POST', '/api/share/intake', $body, share_multipart($body));
    $after = (int)$pdo->query('SELECT COUNT(*) FROM records')->fetchColumn();
    assertSame($after, $before, 'a share is parked, not recorded');
    // And it created no space either: there is nothing here to belong to one.
    assertSame((int)$pdo->query('SELECT COUNT(*) FROM spaces')->fetchColumn(), 0, 'no space is created');
});
