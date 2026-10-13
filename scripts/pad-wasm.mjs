// Experimental workaround for WebKit OMG compiler memory spikes.
// See https://github.com/frankhinek/webkit-wasm-compiler-memory-repro
// Only code-body sizes change; signatures, indices, imports, exports and data do not.
export function uleb(value) {
  const bytes=[];
  do { const byte=value % 128; value=Math.floor(value/128); bytes.push(byte | (value ? 128 : 0)); } while(value);
  return Buffer.from(bytes);
}
export function readUleb(bytes, offset) {
  let value=0, shift=0;
  for(let i=0;i<5;i++) {
    if(offset>=bytes.length) throw Error('Truncated LEB128');
    const byte=bytes[offset++]; value+=(byte&127)*2**shift;
    if(!(byte&128)) { if(value>0xffffffff) throw Error('Invalid u32'); return [value,offset]; }
    shift+=7;
  }
  throw Error('Invalid LEB128');
}
export function padWasm(input, {minimum=40000,target=160000}={}) {
  const bytes=Buffer.from(input);
  if(!bytes.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0]))) throw Error('Invalid WASM header');
  if(!Number.isInteger(minimum)||!Number.isInteger(target)||minimum<1||target<=minimum+5) throw Error('Invalid padding bounds');
  const chunks=[bytes.subarray(0,8)], changed=[];
  let offset=8, seenCode=false;
  while(offset<bytes.length) {
    const start=offset, id=bytes[offset++];
    const [length,payload]=readUleb(bytes,offset); const end=payload+length;
    if(end>bytes.length) throw Error('Truncated section');
    if(id!==10) chunks.push(bytes.subarray(start,end));
    else {
      if(seenCode) throw Error('Duplicate code section'); seenCode=true;
      const section=bytes.subarray(payload,end);
      let [count,pos]=readUleb(section,0); const bodies=[uleb(count)];
      for(let index=0;index<count;index++) {
        const [size,bodyStart]=readUleb(section,pos); pos=bodyStart+size;
        if(pos>section.length||section[pos-1]!==0x0b) throw Error('Invalid function body');
        const body=section.subarray(bodyStart,pos);
        if(size>=minimum && size<target) {
          // A no-result block branches over unreachable nops. Placed immediately
          // before the function's final end; existing branches/stack are untouched.
          const added=Math.max(5,target-size);
          const padding=Buffer.alloc(added,0x01);
          padding.set([0x02,0x40,0x0c,0x00]); padding[added-1]=0x0b;
          bodies.push(uleb(size+added),body.subarray(0,-1),padding,body.subarray(-1));
          changed.push({definedFunctionIndex:index,originalBytes:size,paddedBytes:size+added});
        } else bodies.push(uleb(size),body);
      }
      if(pos!==section.length) throw Error('Unexpected code-section bytes');
      const code=Buffer.concat(bodies); chunks.push(Buffer.from([10]),uleb(code.length),code);
    }
    offset=end;
  }
  if(!seenCode) throw Error('Missing code section');
  return {bytes:Buffer.concat(chunks),changed,minimum,target};
}
