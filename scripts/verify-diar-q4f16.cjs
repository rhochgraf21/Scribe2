// Verify the upstream artifact and reproduce its bounded integrity manifest.
// Usage: node scripts/verify-diar-q4f16.cjs /path/to/browser-models/diar [q4|q4f16]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dtype = process.argv[3] || 'q4f16';
if (!['q4','q4f16'].includes(dtype)) throw Error('Choose q4 or q4f16');
const manifest = require(`../config/diar-${dtype}.json`);
const blockSize = 4194304, files = {};
for (const file of manifest.files.filter(file => file.lfs)) {
 const bytes = fs.readFileSync(path.join(process.argv[2],file.rfilename));
 const hash = crypto.createHash('sha256').update(bytes).digest('hex');
 if (bytes.length !== file.size || hash !== file.lfs.sha256) throw Error(`Integrity mismatch: ${file.rfilename}`);
 const hashes = [];
 for(let offset=0;offset<bytes.length;offset+=blockSize) hashes.push(crypto.createHash('sha256').update(bytes.subarray(offset,offset+blockSize)).digest('hex'));
 files[`diar/${file.rfilename}`] = {sha256:hash,hashes};
}
console.log(JSON.stringify({blockSize,files},null,2));
