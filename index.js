const core = require("@actions/core");
const tc = require("@actions/tool-cache");
const exec = require("@actions/exec");
const io = require("@actions/io");
const path = require("path");

const target = core.getInput("target", { required: true });
const variant = core.getInput("variant", { required: true });
const build = core.getInput("build").toUpperCase() === "TRUE";
const buildDir = path.join("/opt/", target, variant);

const tags = {
  "richfelker/musl-cross-make": "perseus",
  "userdocs/qbt-musl-cross-make": "perseus",
};

(async () => {
  const escapedVariant = variant.replace("/", "_");
  try {
    const url = `https://github.com/nginxui/musl-cross-compilers/releases/download/${tags[variant]}/output-${target}-${escapedVariant}.tar.zst`;

    let cachedPath;
    if (build) {
      const destDir = buildDir;
      await io.mkdirP(destDir);
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

      ret = await exec.exec("git", ["clone", `https://github.com/${variant}.git`, destDir], {
        ignoreReturnCode: true,
      });
      if (ret !== 0) {
        throw new Error(`git clone failed with code ${ret}`);
      }

      ret = await exec.exec("sudo", ["-E", "make", "-j4"], {
        cwd: destDir,
        ignoreReturnCode: true,
        env: {
          TARGET: target,
        },
      });
      if (ret !== 0) {
        throw new Error(`make -j4 failed with code ${ret}`);
      }

      ret = await exec.exec("sudo", ["-E", "make", "install"], {
        cwd: destDir,
        ignoreReturnCode: true,
        env: {
          TARGET: target,
        },
      });
      if (ret !== 0) {
        throw new Error(`make install failed with code ${ret}`);
      }
      cachedPath = destDir;
    } else {
      cachedPath = tc.find("mcm", `${target}-${escapedVariant}.tar.zst`);
    }
    if (cachedPath) {
      console.log(`Found installation at ${cachedPath}`);
    } else {
      const toolchainPath = await tc.downloadTool(url);
      const toolchainExtractedFolder = await tc.extractTar(toolchainPath, undefined, "ax");
      cachedPath = await tc.cacheDir(toolchainExtractedFolder, "mcm", `${target}-${escapedVariant}.tar.zst`);
      console.log(`Installed at ${cachedPath}`);
    }
    cachedPath = path.join(cachedPath, "output", "bin");
    console.log(`Binaries are at ${cachedPath}`);
    core.addPath(cachedPath);
    core.setOutput("path", cachedPath);
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
})();
