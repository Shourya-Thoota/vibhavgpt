// Build's 3D models (owner request, 2026-11-15: "a bounded 3D preview with actual export"). Tecton writes a model as a text file, an ASCII
// STL or a Wavefront OBJ, and that file is the export: it is saved, downloaded and zipped exactly as written. This module reads such a file
// into triangles; it is used twice: on the API, to refuse a model that is not valid geometry before it is saved, and for the preview, to
// draw it in the sandboxed iframe. Nothing here runs the file: it is numbers and indices only, within fixed limits.

export const MODEL_LIMITS = Object.freeze({ maxTriangles: 60_000, maxVertices: 120_000, maxCoordinate: 1e6 });
export const MODEL_EXTENSIONS = Object.freeze([".stl", ".obj"]);

export class ModelError extends Error {}

export const isModelPath = (path) => MODEL_EXTENSIONS.some((ext) => String(path).toLowerCase().endsWith(ext));

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
function coordinate(text, where) {
  if (!NUMBER.test(text ?? "")) throw new ModelError(`${where}: "${String(text ?? "").slice(0, 20)}" is not a number.`);
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > MODEL_LIMITS.maxCoordinate) throw new ModelError(`${where}: a coordinate is out of range.`);
  return value;
}

function readStl(text, name) {
  if (!/^\s*solid\b/i.test(text)) throw new ModelError(`${name} is not an ASCII STL file (it must start with "solid").`);
  const positions = [];
  let facets = 0;
  let inLoop = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i].trim().split(/\s+/);
    const word = parts[0]?.toLowerCase();
    const where = `${name} line ${i + 1}`;
    if (word === "facet") { facets += 1; if (facets > MODEL_LIMITS.maxTriangles) throw new ModelError(`${name} has more than ${MODEL_LIMITS.maxTriangles} triangles.`); }
    else if (word === "outer") inLoop = 0;
    else if (word === "vertex") {
      if (parts.length !== 4) throw new ModelError(`${where}: a vertex needs three numbers.`);
      positions.push(coordinate(parts[1], where), coordinate(parts[2], where), coordinate(parts[3], where));
      inLoop += 1;
    } else if (word === "endloop" && inLoop !== 3) throw new ModelError(`${where}: each facet needs exactly three vertices.`);
  }
  if (positions.length !== facets * 9) throw new ModelError(`${name}: its facets and vertices don't match.`);
  return positions;
}

function readObj(text, name) {
  const vertices = [];
  const positions = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i].trim().split(/\s+/);
    const where = `${name} line ${i + 1}`;
    if (parts[0] === "v") {
      if (parts.length < 4) throw new ModelError(`${where}: a vertex needs three numbers.`);
      if (vertices.length / 3 >= MODEL_LIMITS.maxVertices) throw new ModelError(`${name} has more than ${MODEL_LIMITS.maxVertices} vertices.`);
      vertices.push(coordinate(parts[1], where), coordinate(parts[2], where), coordinate(parts[3], where));
    } else if (parts[0] === "f") {
      const count = vertices.length / 3;
      const indices = parts.slice(1).map((token) => {
        const raw = token.split("/")[0];
        if (!/^-?\d+$/.test(raw)) throw new ModelError(`${where}: "${token.slice(0, 20)}" is not a vertex number.`);
        const n = Number(raw);
        const index = n < 0 ? count + n : n - 1;
        if (n === 0 || index < 0 || index >= count) throw new ModelError(`${where}: face refers to vertex ${n}, which isn't defined before it.`);
        return index;
      });
      if (indices.length < 3) throw new ModelError(`${where}: a face needs at least three vertices.`);
      for (let k = 1; k < indices.length - 1; k += 1) {
        for (const index of [indices[0], indices[k], indices[k + 1]]) positions.push(vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]);
        if (positions.length / 9 > MODEL_LIMITS.maxTriangles) throw new ModelError(`${name} has more than ${MODEL_LIMITS.maxTriangles} triangles.`);
      }
    }
  }
  return positions;
}

/** A model file's triangles: { positions: number[] (9 per triangle), triangles, min, max, size }. Throws ModelError if it is not valid. */
export function readModel(text, path = "model") {
  const name = String(path).split("/").pop();
  const lower = name.toLowerCase();
  const positions = lower.endsWith(".stl") ? readStl(String(text), name) : lower.endsWith(".obj") ? readObj(String(text), name) : null;
  if (!positions) throw new ModelError(`${name} is not an STL or OBJ file.`);
  if (!positions.length) throw new ModelError(`${name} has no triangles.`);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 1) { const axis = i % 3; if (positions[i] < min[axis]) min[axis] = positions[i]; if (positions[i] > max[axis]) max[axis] = positions[i]; }
  const size = max.map((value, axis) => value - min[axis]);
  if (size.filter((value) => value > 0).length < 2) throw new ModelError(`${name} is flat or a single point: it has no surface to show.`);
  return { positions, triangles: positions.length / 9, min, max, size };
}

const round = (value) => Number(value.toPrecision(7));

// The viewer that runs inside the sandboxed preview: plain WebGL, no library, no network. Drag to turn, wheel or pinch to zoom.
const VIEWER = `(()=>{const M=window.__vgModel,c=document.getElementById("view"),gl=c.getContext("webgl",{antialias:true});const info=document.getElementById("info");
if(!gl){info.textContent="This browser can't draw 3D here (WebGL is off). Download the file to open it in a 3D app.";return;}
const p=M.positions,n=new Float32Array(p.length),ctr=[0,1,2].map(a=>(M.min[a]+M.max[a])/2),R=Math.max(1e-9,Math.hypot(M.size[0],M.size[1],M.size[2])/2);
const v=new Float32Array(p.length);for(let i=0;i<p.length;i+=9){const a=[p[i]-ctr[0],p[i+1]-ctr[1],p[i+2]-ctr[2]],b=[p[i+3]-ctr[0],p[i+4]-ctr[1],p[i+5]-ctr[2]],d=[p[i+6]-ctr[0],p[i+7]-ctr[1],p[i+8]-ctr[2]];
const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],w=[d[0]-a[0],d[1]-a[1],d[2]-a[2]];let x=u[1]*w[2]-u[2]*w[1],y=u[2]*w[0]-u[0]*w[2],z=u[0]*w[1]-u[1]*w[0];const l=Math.hypot(x,y,z)||1;x/=l;y/=l;z/=l;
for(let k=0;k<3;k++){const q=[a,b,d][k];v.set([q[0]/R,q[1]/R,q[2]/R],i+k*3);n.set([x,y,z],i+k*3);}}
const sh=(t,s)=>{const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);return o;};const pr=gl.createProgram();
gl.attachShader(pr,sh(gl.VERTEX_SHADER,"attribute vec3 p;attribute vec3 n;uniform mat4 m;uniform mat4 r;varying vec3 vn;void main(){vn=(r*vec4(n,0.)).xyz;gl_Position=m*vec4(p,1.);}"));
gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,"precision mediump float;varying vec3 vn;void main(){vec3 N=normalize(vn);float d=abs(dot(N,normalize(vec3(.4,.6,.9))));gl_FragColor=vec4(vec3(.32,.5,.86)*(.28+.72*d),1.);}"));
gl.linkProgram(pr);gl.useProgram(pr);const buf=(data,name)=>{const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);const l=gl.getAttribLocation(pr,name);gl.enableVertexAttribArray(l);gl.vertexAttribPointer(l,3,gl.FLOAT,false,0,0);};
buf(v,"p");buf(n,"n");gl.enable(gl.DEPTH_TEST);let yaw=.7,pitch=-.5,zoom=2.6;
const mul=(a,b)=>{const o=new Array(16).fill(0);for(let i=0;i<4;i++)for(let j=0;j<4;j++)for(let k=0;k<4;k++)o[j*4+i]+=a[k*4+i]*b[j*4+k];return o;};
const rx=t=>[1,0,0,0,0,Math.cos(t),Math.sin(t),0,0,-Math.sin(t),Math.cos(t),0,0,0,0,1],ry=t=>[Math.cos(t),0,-Math.sin(t),0,0,1,0,0,Math.sin(t),0,Math.cos(t),0,0,0,0,1];
function draw(){const W=c.clientWidth,H=c.clientHeight,dpr=Math.min(2,devicePixelRatio||1);c.width=W*dpr;c.height=H*dpr;gl.viewport(0,0,c.width,c.height);gl.clearColor(.96,.97,.99,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
const f=1/Math.tan(.45),asp=W/Math.max(1,H),nr=.05,fr=50,P=[f/asp,0,0,0,0,f,0,0,0,0,(fr+nr)/(nr-fr),-1,0,0,2*fr*nr/(nr-fr),0],T=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,-zoom,1],Rm=mul(rx(pitch),ry(yaw));
gl.uniformMatrix4fv(gl.getUniformLocation(pr,"m"),false,new Float32Array(mul(P,mul(T,Rm))));gl.uniformMatrix4fv(gl.getUniformLocation(pr,"r"),false,new Float32Array(Rm));gl.drawArrays(gl.TRIANGLES,0,v.length/3);}
let drag=null;c.addEventListener("pointerdown",e=>{drag=[e.clientX,e.clientY];c.setPointerCapture(e.pointerId);});c.addEventListener("pointerup",()=>{drag=null;});
c.addEventListener("pointermove",e=>{if(!drag)return;yaw+=(e.clientX-drag[0])*.01;pitch=Math.max(-1.5,Math.min(1.5,pitch+(e.clientY-drag[1])*.01));drag=[e.clientX,e.clientY];draw();});
c.addEventListener("wheel",e=>{e.preventDefault();zoom=Math.max(1.2,Math.min(12,zoom*(e.deltaY>0?1.1:.9)));draw();},{passive:false});
addEventListener("keydown",e=>{const s={ArrowLeft:[-.1,0],ArrowRight:[.1,0],ArrowUp:[0,-.1],ArrowDown:[0,.1]}[e.key];if(s){yaw+=s[0];pitch=Math.max(-1.5,Math.min(1.5,pitch+s[1]));draw();}});
addEventListener("resize",draw);draw();document.body.dataset.drawn=String(v.length/9);})();`;

/** The preview page for a model: its triangles, sizes and the viewer, inside the page shell the caller provides. */
export function modelPreviewParts(text, path) {
  const model = readModel(text, path);
  const data = { positions: model.positions.map(round), min: model.min.map(round), max: model.max.map(round), size: model.size.map(round) };
  const fmt = (value) => String(Number(value.toPrecision(4)));
  const name = String(path).split("/").pop();
  const styles = "html,body{margin:0;height:100%;font:13px system-ui,sans-serif;color:#333;background:#f5f7fb}#view{display:block;width:100%;height:calc(100% - 34px);touch-action:none;cursor:grab}#info{height:34px;line-height:34px;padding:0 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}";
  const body = `<canvas id="view" tabindex="0" aria-label="3D view of ${name.replace(/[<>&"]/g, "")}. Drag or use the arrow keys to turn it; scroll to zoom."></canvas>`
    + `<div id="info">${name.replace(/[<>&"]/g, "")}: ${model.triangles} triangles · ${model.size.map(fmt).join(" × ")} (in the file's units; STL and OBJ don't record units)</div>`;
  const script = `window.__vgModel=${JSON.stringify(data)};\n${VIEWER}`;
  return { styles, body, script, model };
}
