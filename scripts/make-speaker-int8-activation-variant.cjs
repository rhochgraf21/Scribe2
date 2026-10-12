// Patch only the small ONNX graph. External weights and the verified source stay intact.
// Usage: node scripts/make-speaker-int8-activation-variant.cjs SOURCE OUTPUT
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { onnx } = require(path.join(path.dirname(require.resolve('onnxruntime-web')), '../lib/onnxjs/ort-schema/protobuf/onnx.js'));
const [source, output] = process.argv.slice(2);
if (!source || !output || path.resolve(source) === path.resolve(output)) throw Error('Provide distinct source and output graph paths');
const original = fs.readFileSync(source), model = onnx.ModelProto.decode(original);
let patched = 0;
for (const node of model.graph.node) {
  if (node.opType !== 'MatMulNBits') continue;
  assert.equal(Number(node.attribute.find(a=>a.name==='bits')?.i), 8);
  assert.equal(Number(node.attribute.find(a=>a.name==='block_size')?.i), 32);
  assert.ok(!node.attribute.some(a=>a.name==='accuracy_level'), 'Expected original default accuracy');
  node.attribute.push(onnx.AttributeProto.create({name:'accuracy_level', type:onnx.AttributeProto.AttributeType.INT, i:4}));
  patched++;
}
assert.equal(patched,127);
const variant = Buffer.from(onnx.ModelProto.encode(model).finish());
const restored = onnx.ModelProto.decode(variant);
for (const node of restored.graph.node) if(node.opType==='MatMulNBits') node.attribute = node.attribute.filter(a=>a.name!=='accuracy_level');
assert.deepEqual(restored,onnx.ModelProto.decode(original), 'Only accuracy_level may change');
fs.writeFileSync(output,variant,{flag:'wx'});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({patched,sourceSha256:sha(original),variantSha256:sha(variant),bytes:variant.length,externalWeightsUnchanged:true},null,2));
