import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './support/load-ts.mjs';
import {jpegFixture} from './support/jpeg-fixture.mjs';

const subject=()=>loadTs(new URL('../src/media/previewModel.ts',import.meta.url));
test('embedded previews accept only bounded, canonical, cleaned JPEG pixels',()=>{
  const {createPreview,validPreview,previewUri}=subject();
  const value=createPreview(jpegFixture());
  assert.equal(value.mimeType,'image/jpeg');assert.equal(value.width,2);assert.equal(value.height,2);
  assert.equal(validPreview(value),true);assert.match(previewUri(value),/^data:image\/jpeg;base64,/);
  assert.equal(previewUri({...value,base64:'https://outside.example/image'}),null);
});
test('preview dimensions, payload size and unknown fields cannot bypass the embedded boundary',()=>{
  const {createPreview,validPreview}=subject(),value=createPreview(jpegFixture());
  for(const invalid of [{...value,width:256},{...value,height:0},{...value,mimeType:'image/svg+xml'},{...value,base64:value.base64+'\n'},{...value,base64:'A'.repeat(16400)},{...value,url:'https://outside.example'}])assert.equal(validPreview(invalid),false);
  assert.equal(validPreview(undefined),true);assert.equal(validPreview(null),false);
});
test('previews strip APP metadata and reject externally supplied unsanitized JPEGs',()=>{
  const {createPreview,validPreview}=subject(),raw=jpegFixture();
  const value=createPreview(raw);assert.equal(Buffer.from(value.base64,'base64').includes(Buffer.from('JFIF')),false);
  assert.equal(validPreview({...value,base64:Buffer.from(raw).toString('base64')}),false);
});
test('only bounded technical media values are accepted in encrypted messages',()=>{
  const {validMedia}=subject();
  for(const value of [undefined,{}, {width:320,height:240,durationMs:1000,hdr:'pq'}, {durationMs:0}])assert.equal(validMedia(value),true);
  for(const value of [null,{width:0},{height:20001},{durationMs:Infinity},{durationMs:-1},{hdr:'dolby'},{gps:'secret'},[]])assert.equal(validMedia(value),false);
});
