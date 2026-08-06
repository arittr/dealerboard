import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.drewritter.stream-deck-agents.sdPlugin";
const stageDirectory = "dist/plugin-stage";
const stageRoot = path.resolve(stageDirectory);

// @rollup/plugin-typescript drives the classic TypeScript compiler API
// (createLanguageService), which the pinned typescript@7 native package no
// longer exposes. The supported TS7 entry point is the tsc CLI, so each build
// stages TypeScript to JS plus per-module sourcemaps under dist/ and Rollup
// bundles the staged output. Every other plugin matches the official
// scaffold, and only the plugin entry's import graph is staged, so no
// Bun-only core module can leak into the bundle.
const stageTypescript = {
	name: "stage-typescript",
	buildStart() {
		rmSync(stageDirectory, { recursive: true, force: true });
		execFileSync(
			process.execPath,
			[
				"node_modules/typescript/lib/tsc.js",
				"--ignoreConfig",
				"--types", "node",
				"src/plugin/plugin.ts",
				"--outDir", stageDirectory,
				"--rootDir", "src",
				"--target", "es2022",
				"--module", "esnext",
				"--moduleResolution", "bundler",
				"--strict",
				"--noUncheckedIndexedAccess",
				"--skipLibCheck",
				"--sourceMap",
				"--inlineSources",
			],
			{ stdio: "inherit" },
		);
	},
};

// Hand each staged module's tsc sourcemap to Rollup through the load hook so
// the final bundle map chains back to the TypeScript sources rather than the
// intermediate JS. (Rollup only honors cross-file source identities from a
// load-time map; transform maps are treated as step-to-step links.)
const chainStagedSourcemaps = {
	name: "chain-staged-sourcemaps",
	load(id) {
		if (!id.startsWith(stageRoot)) {
			return null;
		}
		const mapPath = `${id}.map`;
		if (!existsSync(mapPath)) {
			return null;
		}
		return {
			code: readFileSync(id, "utf8").replace(/\n\/\/# sourceMappingURL=[^\n]*\s*$/, "\n"),
			map: JSON.parse(readFileSync(mapPath, "utf8")),
		};
	},
};

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: `${stageDirectory}/plugin/plugin.js`,
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		format: "es",
		sourcemap: true,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		}
	},
	plugins: [
		stageTypescript,
		chainStagedSourcemaps,
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true
		}),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			}
		}
	]
};

export default config;
