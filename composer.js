class Composer {
  constructor(opts) {
    const { width = 1280, height = 720, fps = 30 } = opts;
    this.width = width;
    this.height = height;
    this.fps = fps;

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext("2d");
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  async compose(blobs, opts) {
    const { outroSeconds = 3, logoUrl, outroAudio, outroAudioRegion } = opts;
    const introAsset = opts.introAsset || null;

    const ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') await ac.resume();

    const stream = this.canvas.captureStream(this.fps);
    const mixDest = ac.createMediaStreamDestination();
    const masterGain = ac.createGain();
    masterGain.gain.value = 1.0;
    masterGain.connect(mixDest);
    stream.addTrack(mixDest.stream.getAudioTracks()[0]);

    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9,opus", audioBitsPerSecond: 256000, videoBitsPerSecond: 5000000 });
    const outChunks = [];
    recorder.ondataavailable = e => { if (e.data.size) outChunks.push(e.data); };

    const drawLetterbox = () => {
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, this.width, this.height);
    };

    const playVideoBlob = (blob) => {
      return new Promise((resolve, reject) => {
        const v = document.createElement("video");
        v.src = URL.createObjectURL(blob);
        v.playsInline = true;
        v.crossOrigin = "anonymous";
        v.muted = true; v.volume = 0;

        const srcNode = ac.createMediaElementSource(v);
        srcNode.connect(masterGain);

        let renderLoopId;
        const render = () => {
          drawLetterbox();
          if (v.readyState >= 2) { // HAVE_CURRENT_DATA
            const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
            const scale = Math.min(this.width / vw, this.height / vh);
            const dw = vw * scale, dh = vh * scale;
            const dx = (this.width - dw) / 2, dy = (this.height - dh) / 2;
            this.ctx.drawImage(v, dx, dy, dw, dh);
          }
          if (!v.paused && !v.ended) {
            renderLoopId = requestAnimationFrame(render);
          }
        };

        v.addEventListener("loadeddata", () => { 
          v.play().then(() => {
            render();
          }).catch((err) => {
            console.warn("Video play failed, continuing anyway:", err);
            render(); // Still try to render
          }); 
        }, { once: true });
        
        v.addEventListener("ended", () => {
          cancelAnimationFrame(renderLoopId);
          srcNode.disconnect();
          URL.revokeObjectURL(v.src);
          v.src = "";
          v.remove();
          resolve();
        }, { once: true });
        
        v.addEventListener("error", (e) => {
          console.warn("Video error, skipping:", e);
          cancelAnimationFrame(renderLoopId);
          srcNode.disconnect();
          URL.revokeObjectURL(v.src);
          v.src = "";
          v.remove();
          // Don't reject, just resolve to continue
          resolve();
        });
      });
    };

    const playIntro = async () => {
      if (!introAsset) return;
      if (introAsset.type === 'video') {
        const vBlob = typeof introAsset.src === 'string' ? await (await fetch(introAsset.src)).blob() : introAsset.src;
        await playVideoBlob(vBlob);
      } else if (introAsset.type === 'image') {
        try {
          const img = await this._loadImage(introAsset.src);
          const durMs = Math.max(500, (introAsset.duration || 2) * 1000);
          await new Promise((resolve)=>{
            const start = performance.now();
            const render = () => {
              drawLetterbox();
              const iw = Math.min(this.width * 0.6, img.width), ih = iw * (img.height / img.width);
              this.ctx.drawImage(img, (this.width - iw)/2, (this.height - ih)/2, iw, ih);
              if (performance.now() - start < durMs) requestAnimationFrame(render); else resolve();
            };
            render();
          });
        } catch {}
      }
    };

    const playOutro = async () => {
      try {
        const img = await this._loadImage(logoUrl);
        if (outroAudio) {
          if (outroAudioRegion) {
            const audioBuffer = await fetch(outroAudio).then(r => r.arrayBuffer()).then(ab => ac.decodeAudioData(ab));
            const source = ac.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(masterGain);
            const offset = outroAudioRegion ? Math.max(0, outroAudioRegion.start) : 0;
            const dur = outroAudioRegion ? Math.max(0.001, outroAudioRegion.end - outroAudioRegion.start) : undefined;
            source.start(ac.currentTime, offset, dur);
          } else {
            const audio = new Audio(outroAudio);
            audio.crossOrigin = "anonymous";
            const aNode = ac.createMediaElementSource(audio);
            aNode.connect(masterGain);
            audio.addEventListener('ended', () => aNode.disconnect(), { once: true });
            await audio.play().catch(() => {});
          }
        }

        const dur = outroSeconds * 1000;
        return new Promise((resolve) => {
          const start = performance.now();
          const render = () => {
            drawLetterbox();
            const iw = Math.min(this.width * 0.5, img.width), ih = iw * (img.height / img.width);
            this.ctx.drawImage(img, (this.width - iw) / 2, (this.height - ih) / 2, iw, ih);
            if (performance.now() - start < dur) {
              requestAnimationFrame(render);
            } else {
              resolve();
            }
          };
          render();
        });
      } catch (e) {
        console.warn("Outro rendering failed:", e);
        // Still wait for outro duration even if logo fails
        return new Promise(resolve => setTimeout(resolve, outroSeconds * 1000));
      }
    };
    
    recorder.start(200);

    if (introAsset) await playIntro();
    for (const b of blobs) {
      await playVideoBlob(b);
    }
    
    // Always play outro if we have logoUrl
    if (logoUrl) {
      await playOutro();
    }

    recorder.stop();
    const done = await new Promise((res) => { recorder.onstop = () => res(new Blob(outChunks, { type: "video/webm" })); });
    
    stream.getTracks().forEach(track => track.stop());
    masterGain.disconnect();

    try {
      if (ac.state !== 'closed') await ac.close();
    } catch(e) {
      console.warn("Could not close AudioContext", e);
    }
    
    return done;
  }

  _loadImage(url) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.crossOrigin = "anonymous";
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = encodeURI(url);
    });
  }

  destroy() {
  }
}

export { Composer };

export async function concatenateClips(blobs, opts) {
    const { 
      width = 1280, 
      height = 720, 
      fps = 30,
      outroSeconds = 3, 
      logoUrl, 
      outroAudio, 
      outroAudioRegion 
    } = opts;
    const introAsset = opts.introAsset || null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);

    const stream = canvas.captureStream(fps);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') await ac.resume();
    const mixDest = ac.createMediaStreamDestination();
    const masterGain = ac.createGain();
    masterGain.gain.value = 1.0;
    masterGain.connect(mixDest);
    stream.addTrack(mixDest.stream.getAudioTracks()[0]);

    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9,opus", audioBitsPerSecond: 256000, videoBitsPerSecond: 5000000 });
    const outChunks = [];
    recorder.ondataavailable = e => { if (e.data.size) outChunks.push(e.data); };

    const drawLetterbox = () => { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height); };
    
    const _loadImage = (url) => {
        return new Promise((res, rej) => {
            const i = new Image();
            i.crossOrigin = "anonymous";
            i.onload = () => res(i);
            i.onerror = rej;
            i.src = encodeURI(url);
        });
    }

    async function playVideoBlob(blob) {
        return new Promise((resolve, reject) => {
            const v = document.createElement("video");
            v.src = URL.createObjectURL(blob);
            v.playsInline = true;
            v.crossOrigin = "anonymous";
            v.muted = true; v.volume = 0;
            const srcNode = ac.createMediaElementSource(v);
            srcNode.connect(masterGain);
            let renderLoopId;
            const render = () => {
                drawLetterbox();
                if (v.readyState >= 2) { // HAVE_CURRENT_DATA
                  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
                  const scale = Math.min(width / vw, height / vh);
                  const dw = vw * scale, dh = vh * scale;
                  const dx = (width - dw) / 2, dy = (height - dh) / 2;
                  ctx.drawImage(v, dx, dy, dw, dh);
                }
                if (!v.paused && !v.ended) {
                    renderLoopId = requestAnimationFrame(render);
                }
            };
            v.addEventListener("loadeddata", () => {
                v.play().then(() => {
                  render();
                }).catch((err) => {
                  console.warn("Video play failed, continuing anyway:", err);
                  render();
                });
            }, { once: true });
            v.addEventListener("ended", () => {
                cancelAnimationFrame(renderLoopId);
                srcNode.disconnect();
                URL.revokeObjectURL(v.src);
                v.remove();
                resolve();
            }, { once: true });
            v.addEventListener("error", (e) => {
                console.warn("Video error, skipping:", e);
                cancelAnimationFrame(renderLoopId);
                srcNode.disconnect();
                URL.revokeObjectURL(v.src);
                v.remove();
                resolve(); // Don't reject, continue
            });
        });
    }
    
    const playIntro = async () => {
      if (!introAsset) return;
      if (introAsset.type === 'video') {
        const vBlob = typeof introAsset.src === 'string' ? await (await fetch(introAsset.src)).blob() : introAsset.src;
        await playVideoBlob(vBlob);
      } else if (introAsset.type === 'image') {
        try {
          const img = await _loadImage(introAsset.src);
          const durMs = Math.max(500, (introAsset.duration || 2) * 1000);
          await new Promise((resolve)=>{
            const start = performance.now();
            const render = () => {
              drawLetterbox();
              const iw = Math.min(width * 0.6, img.width), ih = iw * (img.height / img.width);
              ctx.drawImage(img, (width - iw)/2, (height - ih)/2, iw, ih);
              if (performance.now() - start < durMs) requestAnimationFrame(render); else resolve();
            };
            render();
          });
        } catch {}
      }
    };

    const playOutro = async () => {
      try {
        const img = await _loadImage(logoUrl);
        if (outroAudio) {
          if (outroAudioRegion) {
            const audioBuffer = await fetch(outroAudio).then(r => r.arrayBuffer()).then(ab => ac.decodeAudioData(ab));
            const source = ac.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(masterGain);
            const offset = outroAudioRegion ? Math.max(0, outroAudioRegion.start) : 0;
            const dur = outroAudioRegion ? Math.max(0.001, outroAudioRegion.end - outroAudioRegion.start) : undefined;
            source.start(ac.currentTime, offset, dur);
          } else {
            const audio = new Audio(outroAudio);
            audio.crossOrigin = "anonymous";
            const aNode = ac.createMediaElementSource(audio);
            aNode.connect(masterGain);
            audio.addEventListener('ended', () => aNode.disconnect(), { once: true });
            await audio.play().catch(() => {});
          }
        }

        const dur = outroSeconds * 1000;
        return new Promise((resolve) => {
          const start = performance.now();
          const render = () => {
            drawLetterbox();
            const iw = Math.min(width * 0.5, img.width), ih = iw * (img.height / img.width);
            ctx.drawImage(img, (width - iw) / 2, (height - ih) / 2, iw, ih);
            if (performance.now() - start < dur) {
              requestAnimationFrame(render);
            } else {
              resolve();
            }
          };
          render();
        });
      } catch (e) {
        console.warn("Outro rendering failed:", e);
        return new Promise(resolve => setTimeout(resolve, outroSeconds * 1000));
      }
    };

    recorder.start(200);

    if (introAsset) await playIntro();
    for (const b of blobs) {
        await playVideoBlob(b);
    }
    
    // Always play outro if we have logoUrl
    if (logoUrl) {
      await playOutro();
    }

    recorder.stop();

    const done = await new Promise((res) => {
        recorder.onstop = () => res(new Blob(outChunks, { type: "video/webm" }));
    });
    
    stream.getTracks().forEach(track => track.stop());
    masterGain.disconnect();
    try { 
      if (ac.state !== 'closed') await ac.close();
    } catch(e) { console.warn("Could not close AudioContext", e); }
    return done;
}