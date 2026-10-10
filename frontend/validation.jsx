import React from 'react';
import { createRoot } from 'react-dom/client';
import { requestMicrophone } from './src/voice/liveComet.js';
import ImageVoiceInput from './src/components/ImageVoiceInput.jsx';
import ImageWorkspace from './src/components/ImageWorkspace.jsx';
import './src/styles.css';
import './src/planetary.css';
import './src/study.css';
import './src/mobile.css';

const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
const nativeEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
let tracks = [], oscillators = [], context, calls = [];
function log(value) { document.getElementById('result').textContent = JSON.stringify(value, null, 2); }
function simulate(mode) {
  tracks.forEach(track => track.stop());
  oscillators.forEach(oscillator => oscillator.stop());
  tracks = []; oscillators = [];
  calls = [];
  navigator.mediaDevices.getUserMedia = async () => {
    calls.push('getUserMedia');
    context ??= new AudioContext();
    await context.resume();
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    oscillator.connect(destination);
    oscillator.start();
    oscillators.push(oscillator);
    const stream = destination.stream;
    tracks.push(...stream.getTracks());
    return stream;
  };
  navigator.mediaDevices.enumerateDevices = async () => {
    calls.push('enumerateDevices');
    if (mode === 'reject') throw new DOMException('Enumeration unavailable', 'NotFoundError');
    return [];
  };
}
async function run(mode) {
  simulate(mode);
  try {
    const stream = await requestMicrophone();
    log({ result: 'capture succeeded', calls, audioTracks: stream.getAudioTracks().length });
    stream.getTracks().forEach(t => t.stop());
  } catch (e) { log({ result: e.name, message: e.message, calls, leakedLiveTracks: tracks.filter(t => t.readyState === 'live').length }); }
  finally { tracks.forEach(t => t.stop()); }
}
async function native() {
  navigator.mediaDevices.getUserMedia = nativeCapture;
  navigator.mediaDevices.enumerateDevices = nativeEnumerate;
  let outcome;
  try { const stream = await requestMicrophone(); outcome = 'capture succeeded'; stream.getTracks().forEach(t => t.stop()); }
  catch (e) { outcome = `${e.name}: ${e.message}`; }
  log({outcome, devices: (await nativeEnumerate()).map(d => ({kind:d.kind, label:d.label}))});
}
const fixtureImages = Array.from({length:24},(_,i)=>({id:String(i),prompt:`Validation image ${i+1}`,previewUrl:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#567"/></svg>'),createdAt:new Date().toISOString(),meta:{aspectRatio:'square'}}));
async function libraryApi(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:4174${path}`, { ...options, headers: { 'Content-Type': 'application/json' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  // Only preview pixels are synthetic; folder/image metadata uses the real API
  // and an isolated Postgres database. Never fetch production private media.
  if (result.images) result.images = result.images.map(image => ({...image, previewUrl:fixtureImages[0].previewUrl}));
  if (result.image) result.image.previewUrl = fixtureImages[0].previewUrl;
  return result;
}
const galleryApi = location.search.includes('library') ? libraryApi : async path => path.includes('image-folders') ? {folders:[]} : {images:fixtureImages,nextCursor:null};
createRoot(document.getElementById('root')).render(/gallery|library/.test(location.search) ? <div className="workspace"><aside className="sidebar">Validation sidebar</aside><div className="workspace__main" data-product-mode="image"><div className="mode-tabs-bar">Workspace tabs</div><header className="topbar-mobile">Image</header><div className="screen"><ImageWorkspace api={galleryApi}/></div></div></div> : <main>
  <h1>Local microphone validation</h1>
  <p>Simulated capture uses a real Web Audio MediaStream. No audio leaves this page.</p>
  <button onClick={() => run('reject')}>Capture with rejected enumeration</button>
  <button onClick={() => run('empty')}>Capture with empty enumeration</button>
  <button onClick={native}>Check native capture</button>
  <button onClick={() => { simulate('reject'); log('Image simulation ready'); }}>Prepare Image capture</button>
  <ImageVoiceInput api={async (path, options) => { const body=JSON.parse(options.body); log({path, recordedBytes:atob(body.audio).length,calls}); return {text:'Local recording verified'}; }} onText={text => {document.getElementById('transcript').textContent=text;}} onError={log} />
  <pre id="result"/><p id="transcript"/>
</main>);
