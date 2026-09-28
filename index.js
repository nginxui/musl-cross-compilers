const core = require("@actions/core");
const tc = require("@actions/tool-cache");
const exec = require("@actions/exec");
const io = require("@actions/io");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOOL_NAME = "mcm";

const tags = {
  "richfelker/musl-cross-make": "perseus",
  "userdocs/qbt-musl-cross-make": "perseus",
};

// Outer retry budget around tc.downloadTool, which already makes 3 quick
// attempts (10-20s apart). GitHub release downloads occasionally return 5xx
// for a minute or more, so back off further before giving up.
const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_BASE_DELAY_MS = 15000;
const DOWNLOAD_MAX_DELAY_MS = 60000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error) {
  if (error instanceof tc.HTTPError && error.httpStatusCode) {
    const status = error.httpStatusCode;
    // Same policy as tc.downloadTool: 4xx is permanent except 408 and 429.
    return status >= 500 || status === 408 || status === 429;
  }
  // Network errors (reset, timeout, DNS) and truncated archives that fail to extract.
  return true;
}

// tc.find() only resolves semver versions, and our version key is not one, so
// it never returned a hit. Look the tool cache entry up directly instead.
function findCached(version) {
  const toolCache = process.env.RUNNER_TOOL_CACHE;
  if (!toolCache) {
    return "";
  }
  const cachePath = path.join(toolCache, TOOL_NAME, version, os.arch());
  if (fs.existsSync(cachePath) && fs.existsSync(`${cachePath}.complete`)) {
    return cachePath;
  }
  return "";
}

// Downloads and extracts the toolchain archive, retrying the whole
// download+extract with exponential backoff on transient failures.
async function downloadAndExtract(url, options = {}) {
  const attempts = options.attempts || DOWNLOAD_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DOWNLOAD_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DOWNLOAD_MAX_DELAY_MS;

  for (let attempt = 1; ; attempt++) {
    let archivePath;
    try {
      archivePath = await tc.downloadTool(url);
      return await tc.extractTar(archivePath, undefined, "ax");
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) {
        throw error;
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      core.warning(
        `Download attempt ${attempt}/${attempts} of ${url} failed: ${error.message}. Retrying in ${Math.round(delayMs / 1000)}s`,
      );
      await sleep(delayMs);
    } finally {
      if (archivePath) {
        await io.rmRF(archivePath);
      }
    }
  }
}

async function buildToolchain(target, variant, buildDir) {
  await io.mkdirP(buildDir);
  // https://stackoverflow.com/questions/11912878/gcc-error-gcc-error-trying-to-exec-cc1-execvp-no-such-file-or-directory
  let ret = await exec.exec("sudo", ["apt", "update"], {
    ignoreReturnCode: true,
  });
  if (ret !== 0) {
    console.error(`apt update failed with code ${ret}`);
  }

  ret = await exec.exec("sudo", ["apt", "install", "--reinstall", "gcc", "g++", "cpp-11", "cpp-9"], {
    ignoreReturnCode: true,
  });
  if (ret !== 0) {
    console.error(`apt install failed with code ${ret}`);
  }

  ret = await exec.exec("git", ["clone", `https://github.com/${variant}.git`, buildDir], {
    ignoreReturnCode: true,
  });
  if (ret !== 0) {
    throw new Error(`git clone failed with code ${ret}`);
  }

  ret = await exec.exec("sudo", ["-E", "make", "-j4"], {
    cwd: buildDir,
    ignoreReturnCode: true,
    env: {
      TARGET: target,
    },
  });
  if (ret !== 0) {
    throw new Error(`make -j4 failed with code ${ret}`);
  }

  ret = await exec.exec("sudo", ["-E", "make", "install"], {
    cwd: buildDir,
    ignoreReturnCode: true,
    env: {
      TARGET: target,
    },
  });
  if (ret !== 0) {
    throw new Error(`make install failed with code ${ret}`);
  }
  return buildDir;
}

async function run() {
  const target = core.getInput("target", { required: true });
  const variant = core.getInput("variant", { required: true });
  const build = core.getInput("build").toUpperCase() === "TRUE";
  const buildDir = path.join("/opt/", target, variant);
  const escapedVariant = variant.replace("/", "_");
  const version = `${target}-${escapedVariant}.tar.zst`;

  try {
    const url = `https://github.com/nginxui/musl-cross-compilers/releases/download/${tags[variant]}/output-${target}-${escapedVariant}.tar.zst`;

    let cachedPath = build ? await buildToolchain(target, variant, buildDir) : findCached(version);
    if (cachedPath) {
      console.log(`Found installation at ${cachedPath}`);
    } else {
      const toolchainExtractedFolder = await downloadAndExtract(url);
      cachedPath = await tc.cacheDir(toolchainExtractedFolder, TOOL_NAME, version);
      console.log(`Installed at ${cachedPath}`);
    }
    cachedPath = path.join(cachedPath, "output", "bin");
    console.log(`Binaries are at ${cachedPath}`);
    core.addPath(cachedPath);
    core.setOutput("path", cachedPath);
    core.setOutput("directory", cachedPath);
  } catch (e) {
    if (build) {
      console.log("Build error occurred and uploading build directory as artifacts");
      await exec.exec("tar", ["-I", "zstdmt", "-cf", "/opt/mcm.tar.zst", buildDir]);
      const artifact = require("@actions/artifact");
      const artifactClient = artifact.create();
      const artifactName = `musl-cross-compiler-error-${target}-${escapedVariant}`;
      const files = ["/opt/mcm.tar.zst"];
      const rootDirectory = "/opt/";
      const options = {};
      await artifactClient.uploadArtifact(artifactName, files, rootDirectory, options);
    }
    core.setFailed(e);
  }
}

if (require.main === module) {
  run();
}

module.exports = { downloadAndExtract, findCached, isRetryable };
