// obtain list of targets at http://pkg.musl.cc/db/
const fs = require("fs");
const yaml = require("js-yaml");

const targets = fs
  .readFileSync("targets.txt")
  .toString()
  .trim()
  .split(/[\r\n]+/);
//console.log(targets);
const repositories = ["richfelker/musl-cross-make", "nginxui/pmmp-musl-cross-make"];

const data = {
  name: "Build cross compilers",
  on: {
    // builds must be invoked by hand as number of jobs reaches 95,
    // causing Actions queue being filled for an hour
    workflow_dispatch: {
      inputs: {
        do_release: {
          description: 'Create a release and upload files? (type "yes" to create)',
          required: true,
          default: "no",
        },
        release: {
          description: "Release tag and name",
          required: true,
        },
      },
    },
  },
  jobs: {
    prepare: {
      "runs-on": "ubuntu-latest",
      permissions: {
        contents: "write",
      },
      outputs: {
        upload_url: "${{ steps.create_release.outputs.upload_url }}",
      },
      steps: [
        {
          name: "Create release",
          uses: "actions/create-release@v1",
          id: "create_release",
          if: "${{ github.event.inputs.do_release == 'yes' }}",
          with: {
            tag_name: "${{ github.event.inputs.release }}",
            release_name: "${{ github.event.inputs.release }}",
            draft: false,
            prerelease: false,
          },
          env: {
            GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
          },
        },
      ],
    },
    compile: {
      needs: "prepare",
      permissions: {
        contents: "write",
      },
      "runs-on": "ubuntu-latest",
      "continue-on-error": true,
      strategy: {
        matrix: {
          target: targets,
          repo: repositories,
        },
      },
      env: {
        TARGET: "${{ matrix.target }}",
        REPO: "${{ matrix.repo == 'nginxui/pmmp-musl-cross-make' && 'pmmp/musl-cross-make' || matrix.repo }}",
      },
      steps: [
        { uses: "actions/checkout@v2" },
        {
          name: "Clone ${{ matrix.repo }}",
          run: "git clone https://github.com/${{ matrix.repo }} mcm",
        },
        {
          name: "Build ${{ matrix.target }}",
          run: ["make -j4", "make install", "ls output"].join("\n"),
          "working-directory": "mcm",
        },
        {
          name: "Package ${{ matrix.target }}",
          id: "package",
          run: ["tar -czvf ../output-${{ matrix.target }}.tar.gz output/", "echo \"name=source_escaped=${REPO%%/*}_${REPO##*/}\" >> $GITHUB_OUTPUT"].join(
            "\n"
          ),
          "working-directory": "mcm",
        },
        {
          id: "upload-artifacts",
          name: "Upload artifacts",
          if: "\${{ success() }}",
          uses: "cytopia/upload-artifact-retry-action@v0.1.7",
          with: {
            path: "output-${{ matrix.target }}.tar.gz",
            name: "${{ matrix.target }}-${{ steps.package.outputs.source_escaped }}",
          },
        },
        {
          name: "Rename artifact",
          run: "mv output-${{ matrix.target }}.tar.gz output-${{ matrix.target }}-${{ steps.package.outputs.source_escaped }}.tar.gz"
        },
        {
          id: "upload-releases",
          name: "Upload to releases",
          uses: "ncipollo/release-action@v1",
          if: "\${{ github.event.inputs.do_release == 'yes' }}",
          with: {
            allowUpdates: true,
            tag: "${{ github.event.inputs.release }}",
            artifacts: "output-${{ matrix.target }}*.tar.gz",
            artifactContentType: "application/gzip",
          },
          env: {
            GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
          },
        },
      ],
    },
  },
};

console.log(yaml.dump(data));
