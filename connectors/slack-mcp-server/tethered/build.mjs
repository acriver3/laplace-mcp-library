import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const exec=promisify(execFile);
const root=fileURLToPath(new URL('..',import.meta.url));
const assets=resolve(root,'../../browser-runtime/assets');
const temporary=await mkdtemp(join(tmpdir(),'laplace-slack-artifacts-'));
const version='1.2.0-candidate.1';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const engines={};
try {
  await mkdir(assets,{recursive:true});
  for(const [platform,goos] of [['darwin','darwin'],['linux','linux'],['win32','windows']]) {
    for(const [arch,goarch] of [['arm64','arm64'],['x64','amd64']]) {
      const name=`slack-engine-${platform}-${arch}`;
      const file=join(temporary,name);
      await exec(process.env.GO_BINARY || 'go',['build','-trimpath','-buildvcs=false','-ldflags',`-s -w -X github.com/korotovsky/slack-mcp-server/pkg/version.Version=${version}`,'-o',file,'./cmd/slack-mcp-server'],{cwd:root,env:{...process.env,GOOS:goos,GOARCH:goarch,CGO_ENABLED:'0'},timeout:300000});
      const bytes=await readFile(file),compressed=gzipSync(bytes,{level:9});
      await writeFile(join(assets,name+'.gz'),compressed);
      engines[`${platform}-${arch}`]={file:name+'.gz',sha256:hash(bytes),compressedSha256:hash(compressed)};
      process.stdout.write(`${platform}-${arch}: ${hash(bytes)}\n`);
    }
  }
  await writeFile(join(assets,'slack.json'),JSON.stringify({catalogId:'slack-mcp-server',provider:'slack-tethered',version,serverId:'slack',workspace:'https://workspace.slack.com',file:'helper/slack-full-browser.cjs',engines},null,2)+'\n');
} finally {await rm(temporary,{recursive:true,force:true});}
