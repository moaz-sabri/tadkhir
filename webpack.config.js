import path from "path";
import { fileURLToPath } from "url";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import CssMinimizerPlugin from "css-minimizer-webpack-plugin";
import HtmlWebpackPlugin from "html-webpack-plugin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The hash of a file's own content, in its name.
//
// This one line is what makes the two servers below agree about caching, and
// it is the fix for a difference that used to be deliberate in both directions:
// the PHP router sent `Cache-Control: no-store` on /dist/ because the assets
// kept the same URL while their content changed on every build, and nginx sent
// `expires 1y` on the same paths for the ordinary reason that built assets are
// immutable. Both were half right. A build is now a NEW SET OF URLS, so the
// router and nginx can both say "a year, and never revalidate it" and be
// correct, and a rebuilt fix reaches a client that already has the old release
// without anyone pressing Ctrl+F5.
//
// `8` hex characters is 32 bits of a hash nobody is attacking, and it keeps the
// name short enough to read in a server log.
const HASH = "[contenthash:8]";

export default {
    mode: "production",
    target: ["web", "es2020"],
    entry: {
        app: [
            "./app/js/main.js",
            "./app/css/tokens.css",
            "./app/css/base.css",
            "./app/css/layout.css",
            "./app/css/components.css"
        ]
    },
    output: {
        path: path.resolve(__dirname, "app/dist"),
        filename: `app.${HASH}.js`,
        clean: true,
        publicPath: "/dist/"
    },
    module: {
        rules: [
            {
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, "css-loader"]
            },
            {
                test: /\.s[ac]ss$/i,
                use: [MiniCssExtractPlugin.loader, "css-loader", "sass-loader"]
            }
        ]
    },
    optimization: {
        // Off because the service worker and the "one bundle, offline for a
        // week" deployment read better as one unit than as twenty.
        concatenateModules: false,
        minimize: true,
        // `...` is webpack's own Terser pass, kept in the list: naming a
        // minimizer does not replace the default one, it prepends to it. The
        // stylesheet is what needed adding — `minimize: true` alone only ever
        // touched the JavaScript, which is why the extracted CSS shipped with
        // every comment in it.
        minimizer: ["...", new CssMinimizerPlugin()]
    },
    plugins: [
        new MiniCssExtractPlugin({ filename: `app.${HASH}.css` }),
        // The shell is BUILT, not hand-maintained. `app/index.html` is the
        // template and carries no asset URLs at all; this fills in the hashed
        // names and writes the served page to app/dist/index.html, which is the
        // single file the SPA, the service worker and both servers use. So the
        // HTML cannot name an asset that this build did not produce, and there
        // is no second place to update when a name changes.
        new HtmlWebpackPlugin({
            template: "./app/index.html",
            filename: "index.html",
            scriptLoading: "defer",
            inject: "body",
            minify: {
                collapseWhitespace: true,
                removeComments: true,
                removeRedundantAttributes: true,
                useShortDoctype: true
            }
        })
    ],
    performance: { hints: false }
};
