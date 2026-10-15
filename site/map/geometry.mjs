// Projection and polygon math shared in shape with the private map; no editing code.
export function project(x,z,v){return [(x-v.cx)*v.scale+v.width/2,(z-v.cz)*v.scale+v.height/2];}
export function visible(regions,v){
 const w=v.width/2/v.scale,h=v.height/2/v.scale;
 return regions.filter(r=>(r.x+1)*512>v.cx-w&&r.x*512<v.cx+w&&(r.z+1)*512>v.cz-h&&r.z*512<v.cz+h)
  .sort((a,b)=>Math.hypot(a.x*512+256-v.cx,a.z*512+256-v.cz)-Math.hypot(b.x*512+256-v.cx,b.z*512+256-v.cz)).slice(0,48);
}
export function contains(points,x,z){
 let inside=false;
 for(let i=0;i<points.length;i++){
  const a=points[i],b=points[(i+1)%points.length],cross=(b[0]-a[0])*(z-a[1])-(b[1]-a[1])*(x-a[0]);
  if(Math.abs(cross)<1e-7&&x>=Math.min(a[0],b[0])&&x<=Math.max(a[0],b[0])&&z>=Math.min(a[1],b[1])&&z<=Math.max(a[1],b[1]))return true;
  if((a[1]>z)!=(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
 }
 return inside;
}
export function labelSpans(points){
 const ys=points.map(p=>p[1]),top=Math.min(...ys),height=Math.max(...ys)-top;if(height<12)return [];
 const spans=[];
 for(const fraction of [.5,.4,.6,.3,.7]){
  const y=top+height*fraction,xs=[];
  for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];if((a[1]>y)!==(b[1]>y))xs.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));}
  xs.sort((a,b)=>a-b);
  for(let i=0;i+1<xs.length;i+=2){const width=xs[i+1]-xs[i];spans.push({x:(xs[i]+xs[i+1])/2,y,width,score:width*(1-Math.abs(.5-fraction))});}
 }
 return spans.sort((a,b)=>b.score-a.score);
}
