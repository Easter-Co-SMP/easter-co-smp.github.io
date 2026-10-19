// A Minecraft skin PNG for the avatar checks, encoded here rather than committed as a
// binary: the shape of the image is the fixture, and a reader can see it.
//
// The head is deliberately a two-colour checkerboard so a nearest-neighbour draw is
// provable from the canvas pixels: with 8 skin pixels stretched to 32 canvas pixels each
// source pixel owns an exact 4x4 block, and any smoothing would show as an in-between
// colour at the block edge. The hat layer is a half-transparent blue over the whole face
// region, which is what proves the overlay is composited on top of the face rather than
// replacing it.
import {deflateSync} from 'node:zlib';
const CRC=(()=>{
 const table=new Int32Array(256);
 for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c;}
 return table;
})();
function crc32(bytes){
 let c=-1;
 for(const byte of bytes)c=CRC[(c^byte)&0xff]^(c>>>8);
 return (c^-1)>>>0;
}
function chunk(type,data){
 const out=Buffer.alloc(8+data.length+4);
 out.writeUInt32BE(data.length,0);out.write(type,4,'latin1');data.copy(out,8);
 out.writeUInt32BE(crc32(out.subarray(4,8+data.length)),8+data.length);
 return out;
}
// A 64x64 RGBA PNG from a pixel function (x, y) -> [r, g, b, a].
export function png(width,height,pixel){
 const ihdr=Buffer.alloc(13);
 ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);
 ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
 const rows=Buffer.alloc((width*4+1)*height);
 for(let y=0;y<height;y++){
  const start=y*(width*4+1);
  rows[start]=0; // filter: none
  for(let x=0;x<width;x++){
   const [r,g,b,a]=pixel(x,y),at=start+1+x*4;
   rows[at]=r;rows[at+1]=g;rows[at+2]=b;rows[at+3]=a;
  }
 }
 return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rows,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
export const FACE_A=[200,130,90,255];
export const FACE_B=[20,40,60,255];
export const HAT=[0,0,255,128];
// The face pixel (x, y) of the fixture skin is FACE_A or FACE_B by (x+y) parity.
export const faceColour=(x,y)=>(x+y)%2===0?FACE_A:FACE_B;
// The hat layer covers the right-hand two thirds of the face (skin columns 42..47) and is
// transparent over the first two, so a canvas read proves both halves of the rule: the
// face is drawn at all, and the overlay is composited over it rather than replacing it.
export const hatCovers=x=>x>=42&&x<48;
export function skinDataURL(){
 const png64=png(64,64,(x,y)=>{
  if(x>=8&&x<16&&y>=8&&y<16)return faceColour(x,y);
  if(hatCovers(x)&&y>=8&&y<16)return HAT;
  return [0,0,0,0];
 });
 return 'data:image/png;base64,'+png64.toString('base64');
}
// A player's own uploaded picture: one flat colour, so the canvas can be read back exactly.
export function pictureDataURL(colour=[180,60,120,255]){
 return 'data:image/png;base64,'+png(64,64,()=>colour).toString('base64');
}
// What the hat does to a face pixel: the overlay is drawn over it with its own alpha.
export const hatted=colour=>colour.map((value,index)=>Math.round([0,0,255][index]*(HAT[3]/255)+value*(1-HAT[3]/255)));
