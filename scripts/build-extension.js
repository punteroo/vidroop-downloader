const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

/**
 * Logs build lifecycle messages.
 *
 * @param {'INFO' | 'ERROR'} level Log level.
 * @param {string} message Log message.
 * @param {Record<string, unknown>} [meta={}] Optional metadata.
 */
function log(level, message, meta = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    ...meta,
  };

  if (level === 'ERROR') {
    console.error(`[Build:${level}] ${message}`, payload);

    return;
  }

  console.log(`[Build:${level}] ${message}`, payload);
}

/**
 * Copies a file from source to destination.
 *
 * @param {string} source Relative source path from root.
 * @param {string} destination Relative destination path from dist.
 */
function copyFile(source, destination) {
  const sourcePath = path.join(ROOT_DIR, source);
  const destinationPath = path.join(DIST_DIR, destination);

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

/**
 * Copies a directory recursively.
 *
 * @param {string} source Relative source directory from root.
 * @param {string} destination Relative destination directory from dist.
 */
function copyDirectory(source, destination) {
  const sourcePath = path.join(ROOT_DIR, source);
  const destinationPath = path.join(DIST_DIR, destination);

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.cpSync(sourcePath, destinationPath, { recursive: true });
}

/**
 * Builds all extension entry points.
 *
 * @returns {Promise<void>}
 */
async function bundleScripts() {
  const entries = [
    'content.js',
    'background.js',
    'popup.js',
    'conversion.worker.js',
  ];

  await esbuild.build({
    absWorkingDir: ROOT_DIR,
    entryPoints: entries,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome114'],
    outdir: DIST_DIR,
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'silent',
  });

  log('INFO', 'Script bundling completed', { entries });
}

/**
 * Copies static extension assets.
 */
function copyStaticAssets() {
  copyFile('manifest.json', 'manifest.json');
  copyFile('popup.html', 'popup.html');
  copyFile('popup.css', 'popup.css');
  copyFile('icon.png', 'icon.png');
  copyDirectory('_locales', '_locales');

  log('INFO', 'Static assets copied', {
    files: ['manifest.json', 'popup.html', 'popup.css', 'icon.png', '_locales'],
  });
}

/**
 * Cleans the dist directory.
 */
function cleanDist() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  log('INFO', 'Dist directory prepared', { distDir: DIST_DIR });
}

/**
 * Runs the build process end-to-end.
 */
async function run() {
  try {
    cleanDist();
    await bundleScripts();
    copyStaticAssets();

    log('INFO', 'Extension build finished successfully', {
      output: DIST_DIR,
    });
  } catch (error) {
    log('ERROR', 'Extension build failed', {
      reason: error?.message ?? 'unknown',
    });
    process.exitCode = 1;
  }
}

run();
