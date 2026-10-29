// Reproduce from the repository root: node docs/photo-quality/pixel-fixtures.mjs OUTPUT_DIR
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizePng } from '../../mobile/src/photo/png.ts';
import { pngChunk,pngFixture } from '../../mobile/test/support/png-fixture.mjs';

const output=process.argv[2];
if(!output)throw new Error('Provide a directory for generated verification fixtures.');
mkdirSync(output,{recursive:true});
const samples=[
  {name:'rgba-partial-alpha',width:2,height:2,color:6,pixels:[0,255,0,0,0,0,255,0,127,0,0,0,255,255,40,80,120,254],expected:[[255,0,0,0],[0,255,0,127],[0,0,255,255],[40,80,120,254]]},
  {name:'indexed-partial-transparency',width:2,height:1,color:3,pixels:[0,0,1],before:[pngChunk('PLTE',Buffer.from([255,0,0,0,255,0])),pngChunk('tRNS',Buffer.from([0]))],expected:[[255,0,0,0],[0,255,0,255]]},
  {name:'grayscale-transparency',width:2,height:1,color:0,pixels:[0,123,124],before:[pngChunk('tRNS',Buffer.from([0,123]))],expected:[[123,123,123,0],[124,124,124,255]]},
  {name:'truecolor-transparency',width:2,height:1,color:2,pixels:[0,20,40,60,20,40,61],before:[pngChunk('tRNS',Buffer.from([0,20,0,40,0,60]))],expected:[[20,40,60,0],[20,40,61,255]]},
];
const cases=samples.map(sample=>{
  const original=pngFixture({...sample,pixels:Buffer.from(sample.pixels),before:[...(sample.before??[]),pngChunk('tEXt',Buffer.from('Author\0private-test-author'))]});
  const clean=sanitizePng(original);
  assert.deepEqual(sanitizePng(clean.bytes).bytes,clean.bytes);
  assert.deepEqual(clean.removedChunks,['tEXt']);
  writeFileSync(join(output,`${sample.name}-before.png`),original);
  writeFileSync(join(output,`${sample.name}-after.png`),clean.bytes);
  return {name:sample.name,width:sample.width,height:sample.height,expected:sample.expected,idempotent:true,hasAlpha:clean.hasAlpha,removedChunks:clean.removedChunks};
});
writeFileSync(join(output,'fixtures.json'),JSON.stringify({cases},null,2)+'\n');
