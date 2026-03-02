const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').Plugin} */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`
          );
        }
      });
      console.log("[watch] build finished");
    });
  },
};

/** @type {import('esbuild').Plugin} */
const nativeModuleShimPlugin = {
  name: "native-module-shim",
  setup(build) {
    // Redirect native addons to their pure-JS fallbacks
    build.onResolve({ filter: /^bufferutil$/ }, () => ({
      path: require.resolve("bufferutil/fallback"),
    }));
    build.onResolve({ filter: /^utf-8-validate$/ }, () => ({
      path: require.resolve("utf-8-validate/fallback"),
    }));
    // node-rsa is an optional dep of dev-tunnels-ssh — stub it out
    build.onResolve({ filter: /^node-rsa$/ }, () => ({
      path: "empty",
      namespace: "ignore",
    }));
    build.onLoad({ filter: /.*/, namespace: "ignore" }, () => ({
      contents: "module.exports = {}",
    }));
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [nativeModuleShimPlugin, esbuildProblemMatcherPlugin],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
