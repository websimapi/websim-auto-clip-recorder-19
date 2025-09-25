import { Composer, concatenateClips } from "./composer.js";
import { saveClips, loadClips } from './storage.js';
import { saveComposed, loadComposed } from './storage.js';
import { initOutroSelector, getSelectedOutro } from './outroSelector.js';
import { createRecorder } from './recorder.js';
import { createClipEditor } from './clipEditor.js';

const els = {
  pick: document.getElementById("btn-pick-tab"),
  start: document.getElementById("btn-start"),
  stop: document.getElementById("btn-stop"),
  split: document.getElementById("btn-split"),
  grid: document.getElementById("clips-grid"),
  navUrl: document.getElementById("nav-url"),
  navGo: document.getElementById("nav-go"),
  autoSplit: document.getElementById("auto-split-on-nav"),
  navigator: document.getElementById("navigator"),
  composeBtn: document.getElementById("btn-compose"),
  composeStatus: document.getElementById("compose-status"),
  autoSplitCaptured: document.getElementById("auto-split-captured"),
  modalBackdrop: document.getElementById('modal-backdrop'),
  modalVideo: document.getElementById('modal-video'),
  modalClose: document.getElementById('modal-close'),
  outroGrid: document.getElementById('outro-audio-grid'),
  editorModalBackdrop: document.getElementById('editor-modal-backdrop'),
  introImageUrl: document.getElementById('intro-image-url'),
  introVideoUrl: document.getElementById('intro-video-url'),
  introSeconds: document.getElementById('intro-seconds'),
  introFile: document.getElementById('intro-file'),
  composedGrid: document.getElementById('composed-grid'),
  autoComposeToggle: document.getElementById('auto-compose-toggle'),
};

let clips = [];
let composedClips = [];
const clipEditor = createClipEditor(els.editorModalBackdrop);
const compositionQueue = [];
let isComposing = false;
let composer = new Composer({ width: 1280, height: 720, fps: 30 });

function fmtTime(ms){ const s = Math.round(ms/1000); return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; }

async function getVideoDuration(blob){ return new Promise((resolve)=>{ const v=document.createElement('video'); v.preload='metadata'; v.onloadedmetadata=()=>{ URL.revokeObjectURL(v.src); resolve(v.duration*1000); }; v.onerror=()=>resolve(0); v.src=URL.createObjectURL(blob); }); }
async function makeThumb(blob){ return new Promise((res)=>{ const v=document.createElement("video"); v.src=URL.createObjectURL(blob); v.muted=true; v.addEventListener("loadeddata", ()=>{ v.currentTime=Math.min(0.25,(v.duration||1)*0.1); }, {once:true}); v.addEventListener("seeked", ()=>{ const c=document.createElement("canvas"); c.width=320; c.height=180; c.getContext("2d").drawImage(v,0,0,c.width,c.height); c.toBlob(b=>res(URL.createObjectURL(b)),"image/jpeg",0.7); URL.revokeObjectURL(v.src); }, {once:true}); }); }

function toggleComposeBtn(){ els.composeBtn.disabled = !(clips.some(c=>c.selected && !c.composing && (c.blob || c.remoteUrl))); }

function renderComposed(){
  els.composedGrid.innerHTML = "";
  composedClips.forEach((c, idx)=>{
    const card=document.createElement("div"); card.className="clip";
    const img=document.createElement("img"); img.className="thumb"; img.src=c.thumb || c.thumbUrl || "";
    img.addEventListener('click',()=>{ const src=c.blob?URL.createObjectURL(c.blob):c.remoteUrl; if(src){ els.modalVideo.src=src; els.modalBackdrop.style.display='flex'; els.modalVideo.play().catch(()=>{});} });
    const info=document.createElement("div"); info.className="clip-info";
    const meta=document.createElement("div"); meta.className="meta"; meta.textContent=`Composed ${idx+1} • ${c.duration?fmtTime(c.duration):'--:--'} • ${new Date(c.createdAt).toLocaleTimeString()}`;
    const actions=document.createElement("div"); actions.style.padding="0 10px 8px"; actions.style.display="flex"; actions.style.gap="8px";
    const dl=document.createElement("a"); dl.textContent="Download"; dl.href=c.blob?URL.createObjectURL(c.blob):(c.remoteUrl||'#'); if(!c.blob && !c.remoteUrl){ dl.style.pointerEvents='none'; dl.style.opacity='0.5'; } dl.download=`composed-${idx+1}.webm`;
    const delBtn=document.createElement("button"); delBtn.textContent="Delete"; delBtn.addEventListener("click", ()=>{ if(!confirm("Are you sure you want to delete this composed clip?")) return; composedClips = composedClips.filter(x=>x.id!==c.id); renderComposed(); saveComposed(composedClips); });
    actions.appendChild(dl); actions.appendChild(delBtn);
    info.appendChild(meta);
    card.appendChild(img); card.appendChild(info); card.appendChild(actions);
    els.composedGrid.appendChild(card);
  });
}

function renderClips(){
  els.grid.innerHTML = "";
  clips.forEach((c, idx)=>{
    const card=document.createElement("div"); card.className="clip";
    const img=document.createElement("img"); img.className="thumb"; img.src=c.thumb || c.thumbUrl || ""; 
    img.addEventListener('click',()=>{ 
      const src = c.blob ? URL.createObjectURL(c.blob) : (c.remoteUrl || "");
      if(src){ 
        els.modalVideo.src=src; 
        els.modalBackdrop.style.display='flex'; 
        els.modalVideo.play().catch(()=>{}); 
      } 
    });
    
    const info=document.createElement("div"); info.className="clip-info";
    const meta=document.createElement("div"); meta.className="meta"; 
    meta.textContent=`Clip ${idx+1} • ${c.duration?fmtTime(c.duration):'--:--'} • ${new Date(c.createdAt).toLocaleTimeString()}`;
    
    const sel=document.createElement("label"); sel.className="sel";
    const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=c.selected??true; 
    cb.addEventListener("change",()=>{ c.selected=cb.checked; saveClips(clips); toggleComposeBtn(); });
    
    const editBtn=document.createElement("button"); 
    editBtn.textContent="Edit"; 
    editBtn.className="edit-btn";
    editBtn.addEventListener("click", ()=>{
      clipEditor.open(c, recorder, (editedClip) => {
        const clipToUpdate = clips.find(clip => clip.id === editedClip.id);
        if (clipToUpdate) {
            clipToUpdate.startTime = editedClip.editStartTime;
            clipToUpdate.endTime = editedClip.editEndTime;
            clipToUpdate.duration = editedClip.editEndTime - editedClip.editStartTime;
            clipToUpdate.composing = true;
            renderClips();
            saveClips(clips);
            
            compositionQueue.push(clipToUpdate);
            processCompositionQueue();
        }
      });
    });
    
    const actions=document.createElement("div");
    actions.style.padding="0 10px 8px";
    actions.style.display="flex";
    actions.style.gap="8px";
    const composeBtn=document.createElement("button"); composeBtn.textContent="Compose"; composeBtn.addEventListener("click", ()=>{ if(c.composing) return; c.composing=true; renderClips(); compositionQueue.push(c); processCompositionQueue(); });
    actions.appendChild(editBtn);
    actions.appendChild(composeBtn);
    actions.appendChild(dl); 
    const delBtn=document.createElement("button"); delBtn.textContent="Delete";
    delBtn.addEventListener("click", ()=>{
      if(!confirm("Are you sure you want to delete this clip?")) return;
      compositionQueue.splice(0, compositionQueue.length, ...compositionQueue.filter(q=>q.id!==c.id));
      clips = clips.filter(x=>x.id!==c.id);
      renderClips();
      saveClips(clips);
    });
    actions.appendChild(delBtn);
    card.appendChild(actions);
    
    if(c.composing){ 
      const overlay=document.createElement('div'); 
      overlay.className='composing-overlay'; 
      overlay.textContent='Composing...'; 
      card.appendChild(overlay); 
    }
    els.grid.appendChild(card);
  });
  toggleComposeBtn();
}

async function composeSingleClip(clip) {
  try {
    const newBlob = clip.rawBlob || recorder.getContinuousBlob(clip.startTime, clip.endTime);
    if (newBlob.size === 0) throw new Error("Empty blob for composition");
    const outro = getSelectedOutro();
    const composedBlob = await composer.compose([newBlob], {
      outroSeconds: 3,
      logoUrl: "/logowhite (1).png",
      outroAudio: outro.file,
      outroAudioRegion: outro.region || null,
      introAsset: getIntroAsset()
    });
    const createdAt = Date.now();
    const composed = {
      id: `${clip.id}-composed-${createdAt}`,
      srcClipId: clip.id,
      blob: composedBlob,
      createdAt,
      duration: await getVideoDuration(composedBlob),
      thumb: await makeThumb(composedBlob),
      remoteUrl: null,
      thumbUrl: null
    };
    try {
      if (window.websim?.upload) {
        const videoUrl = await window.websim.upload(new File([composedBlob], `clip-${clip.id}-${createdAt}.webm`, { type: composedBlob.type }));
        composed.remoteUrl = videoUrl;
        const thumbBlob = await (await fetch(composed.thumb)).blob();
        const thumbUrl = await window.websim.upload(new File([thumbBlob], `thumb-${clip.id}-${createdAt}.jpg`, { type: thumbBlob.type }));
        composed.thumbUrl = thumbUrl;
      }
    } catch(e){ console.warn("Upload failed for composed clip.", e); }
    composedClips.unshift(composed);
    renderComposed();
    saveComposed(composedClips);
  } catch (e) {
    console.error("Composition failed for clip", clip.id, e);
  } finally {
    clip.composing = false;
    renderClips();
    saveClips(clips);
  }
}

async function processCompositionQueue() {
    if (isComposing || compositionQueue.length === 0) {
        return;
    }
    isComposing = true;
    const clipToProcess = compositionQueue.shift();
    
    try {
        await composeSingleClip(clipToProcess);
    } catch (e) {
        console.error("Error processing composition queue:", e);
    } finally {
        isComposing = false;
        // Use setTimeout to avoid deep recursion and allow UI to update
        setTimeout(processCompositionQueue, 0);
    }
}


const recorder = createRecorder({
  autoSplitOnCaptured: ()=>els.autoSplitCaptured.checked,
  onIframeNavSplit: ()=>els.autoSplit.checked,
  onNewRawClip: async (rawBlob, clipMarker)=>{
    const createdAt=Date.now();
    const thumb = await makeThumb(rawBlob);
    const clip={ 
      id: createdAt + Math.random(), 
      rawBlob, 
      blob:null, 
      createdAt, 
      startTime: clipMarker?.startTime || createdAt,
      endTime: clipMarker?.endTime || createdAt,
      duration:0, 
      thumb, 
      selected:true, 
      composing:false 
    };
    clips.unshift(clip);
    renderClips();
    saveClips(clips);
    if (els.autoComposeToggle.checked) {
      clip.composing = true;
      renderClips();
      compositionQueue.push(clip);
      processCompositionQueue();
    }
  }
});

function setupNavigator(){
  const go=()=>{ const url=els.navUrl.value.trim(); if(!url) return; const href=/^https?:\/\//i.test(url)?url:`https://${url}`; els.navigator.src=href; };
  els.navGo.addEventListener("click", go);
  els.navUrl.addEventListener("keydown",(e)=>{ if(e.key==="Enter") go(); });
}

document.getElementById("btn-compose").addEventListener("click", async ()=>{
  const selected = clips.filter(c=>c.selected && !c.composing && (c.blob || c.remoteUrl));
  if(!selected.length) return;
  els.composeStatus.textContent="Composing..."; els.composeStatus.style.color=""; els.composeBtn.disabled=true;
  try{
    // Ensure blobs from URLs if needed
    const blobs = await Promise.all(selected.map(async c=>{
      if (c.blob) return c.blob;
      const res = await fetch(c.remoteUrl);
      return await res.blob();
    }));
    const outro = getSelectedOutro();
    const out = await concatenateClips(blobs, { 
      width:1280, 
      height:720, 
      fps:30,
      outroSeconds: 3,
      logoUrl: "/logowhite (1).png",
      outroAudio: outro.file,
      outroAudioRegion: outro.region || null,
      introAsset: getIntroAsset()
    });
    const url=URL.createObjectURL(out);
    const prev=document.getElementById("final-preview"); prev.src=url; prev.play().catch(()=>{});
    const a=document.getElementById("download-link"); a.href=url; a.style.display="inline-block";
    els.composeStatus.textContent="Done.";
  }catch(e){ console.error(e); els.composeStatus.textContent="Failed."; els.composeStatus.style.color="crimson"; alert("Composition failed. See console for details."); }
  finally{ els.composeBtn.disabled=false; }
});

els.pick.addEventListener("click", recorder.pickTab);
els.start.addEventListener("click", recorder.start);
els.split.addEventListener("click", recorder.split);
els.stop.addEventListener("click", recorder.stop);

els.modalClose.addEventListener('click', ()=>{ els.modalBackdrop.style.display='none'; els.modalVideo.pause(); els.modalVideo.src=''; });
els.modalBackdrop.addEventListener('click',(e)=>{ if(e.target===els.modalBackdrop) els.modalClose.click(); });

setupNavigator();
initOutroSelector(els.outroGrid);
loadClips().then(restored=>{ clips = restored; renderClips(); });
loadComposed().then(restored=>{ composedClips = restored; renderComposed(); });

function getIntroAsset() {
  const img = els.introImageUrl.value.trim();
  const vid = els.introVideoUrl.value.trim();
  const secs = parseFloat(els.introSeconds.value) || 0;
  if (vid) return { type: 'video', src: vid, duration: Math.max(0.5, secs || 0) };
  if (img) return { type: 'image', src: img, duration: Math.max(0.5, secs || 2) };
  return null;
}

els.introFile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('image/')) {
    els.introVideoUrl.value = '';
    els.introImageUrl.value = url;
    els.introSeconds.value = els.introSeconds.value || 2;
  } else if (file.type.startsWith('video/')) {
    els.introImageUrl.value = '';
    els.introVideoUrl.value = url;
    const durMs = await getVideoDuration(file);
    if (durMs > 0) els.introSeconds.value = Math.round(durMs / 100) / 10;
  }
});