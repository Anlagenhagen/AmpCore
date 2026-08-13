const path = require("path");
require("dotenv").config();
const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

const packagerConfig = {
  name: "AmpCore",
  executableName: "AmpCore",
  appBundleId: "com.ampcore.app",
  appCategoryType: "public.app-category.music",
  icon: path.join(__dirname, "public", "logo"),
  asar: {
    unpack: "**/*.node"
  },
  ignore: [
    // Exclude all node_modules except electron-squirrel-startup
    /^\/node_modules\/(?!electron-squirrel-startup).*$/,
    // Exclude source directories (not needed in packaged app)
    /^\/app\//,
    /^\/components\//,
    /^\/hooks\//,
    // /^\/lib\//, // Allow lib/ to be packaged
    /^\/stores\//,
    /^\/storage\//,
    /^\/Releases\//,
    /^\/\.next\/cache/,
    /^\/\.next\/dev/,
    /^\/\.next\/server/,
    /^\/\.next\/types/,
    /^\/\.next\/app-build-manifest\.json$/,
    /^\/\.next\/build-manifest\.json$/,
    /^\/\.next\/package\.json$/,
    /^\/\.next\/react-loadable-manifest\.json$/,
    /^\/\.next\/trace$/,
    /^\/src\//,
    /^\/\.git/,
    /^\/\.github/,
    /^\/\.vscode/,
    /^\/dist/,
    /^\/out/,
    /\.ts$/,
    /tsconfig\.json$/,
    /eslint\.config/,
    /postcss\.config/,
    /tailwind\.config/,
    /prettier/,
    /^\/BUILD\.md$/,
    /^\/README\.md$/,
    /^\/pnpm-workspace\.yaml$/,
    /^\/pnpm-lock\.yaml$/,
    /^\/\.npmrc$/,
    /^\/components\.json$/
  ]
};

module.exports = {
  packagerConfig,

  rebuildConfig: {},

  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "AmpCore",
        setupIcon: path.join(__dirname, "public", "logo.ico")
      }
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"]
    }
  ],

  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "scalli007YT",
          name: "AmpCore"
        },
        prerelease: true,
        draft: true
      }
    }
  ],

  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {}
    },
    {
      name: "@electron-forge/plugin-fuses",
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false
      }
    }
  ],

  hooks: {
    generateAssets: async () => {
      const { execSync } = require("child_process");
      const fs = require("fs");

      const nextDir = path.join(__dirname, ".next");

      // Allow reusing an already-built .next (e.g. built manually just before) to
      // avoid a redundant rebuild — useful when network is flaky (next/font/google
      // fetches at build time). Default behaviour (clean + build) is unchanged.
      const reuseBuild =
        process.env.SKIP_NEXT_BUILD === "1" && fs.existsSync(path.join(nextDir, "standalone"));

      if (reuseBuild) {
        console.log("↷ SKIP_NEXT_BUILD=1 — reusing existing .next build");
      } else {
        if (fs.existsSync(nextDir)) {
          fs.rmSync(nextDir, { recursive: true, force: true });
          console.log("✓ Cleaned .next directory");
        }
        console.log("Building Next.js application...");
        execSync("pnpm run build", { stdio: "inherit", cwd: __dirname });
        console.log("✓ Next.js build complete");
      }

      // Copy public/ and .next/static/ into standalone dir for Next.js standalone mode.
      const standaloneDir = path.join(__dirname, ".next", "standalone");
      const publicSrc = path.join(__dirname, "public");
      const publicDest = path.join(standaloneDir, "public");
      const staticSrc = path.join(__dirname, ".next", "static");
      const staticDest = path.join(standaloneDir, ".next", "static");

      if (fs.existsSync(publicSrc)) {
        fs.cpSync(publicSrc, publicDest, { recursive: true });
        console.log("✓ Copied public/ into standalone");
      }
      if (fs.existsSync(staticSrc)) {
        fs.cpSync(staticSrc, staticDest, { recursive: true });
        console.log("✓ Copied .next/static/ into standalone");
      }
    }
  }
};
