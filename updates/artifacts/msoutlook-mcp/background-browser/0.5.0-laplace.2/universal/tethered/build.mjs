import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const transportPlugin = {
  name: 'reviewed-browser-transport',
  setup(build) {
    build.onResolve({filter: /client\.js$/}, args => {
      if (resolve(args.resolveDir, args.path) === resolve(root, 'src/api/client.js'))
        return {path: resolve(root, 'src/tethered/client.ts')};
    });
  },
};
export async function buildTethered(outdir = resolve(root, 'dist-tethered')) {
  return build({absWorkingDir: root, entryPoints: ['tethered/entry.ts'], outfile: resolve(outdir, 'server.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', plugins: [transportPlugin], metafile: true});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildTethered();
  const forbidden = Object.keys(built.metafile.inputs).filter(path => /playwright|src\/auth\//.test(path));
  if (forbidden.length) throw Error('Legacy authentication entered tethered bundle: ' + forbidden.join(', '));
}
