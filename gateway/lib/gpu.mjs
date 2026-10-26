// Which GPU encodes the video, and how frames get to it.
//
// Every view is captured with gfxcapture (Windows Graphics Capture), which crops and scales the window
// on the GPU. What happens next depends on the hardware, from cheapest to most expensive:
//
//   gpu       NVIDIA (NVENC) takes the captured Direct3D texture as it is: the CPU never sees a pixel
//             (~0.06 of a core per view at 60 fps on this project's test PC).
//   download  AMD (AMF): the already-scaled BGRA frame is copied to memory and AMF converts and encodes it
//             on the GPU (~0.12 of a core per view; AMF rejects the capture's textures directly).
//   qsv       Intel (Quick Sync): the texture is mapped to Quick Sync and converted to NV12 there.
//   nv12      the same encoders fed NV12 converted on the CPU (fallback when the GPU paths fail).
//   cpu       libx264: no hardware encoder. Only the whole game is streamed, at 30 fps.
//
// The adapters come from ffmpeg itself (d3d11va device N reports its PCI vendor), and each candidate is
// checked with a short synthetic encode before it's used; the room falls back to the next one if the
// real capture still fails.
import { spawn, spawnSync } from 'node:child_process';

const VENDORS = { '10de': 'nvidia', '1002': 'amd', '8086': 'intel' };

export const ENCODE_ARGS = {
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-delay', '0',
    '-rc', 'cbr', '-rc-lookahead', '0', '-forced-idr', '1', '-profile:v', 'baseline'],
  // AMF writes its own AUDs (h264_metadata then added a second one per frame) and ignores -g for IDRs:
  // keyframes come from -force_key_frames and forced_idr makes them IDR, which a new viewer can start on.
  h264_amf: ['-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-quality', 'speed', '-latency', 'true', '-async_depth', '1',
    '-preencode', 'false', '-preanalysis', 'false', '-rc', 'cbr', '-enforce_hrd', 'true', '-profile:v', 'constrained_baseline',
    '-forced_idr', 'true', '-aud', 'false'],
  h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-async_depth', '1', '-look_ahead', '0', '-low_delay_brc', '1',
    '-forced_idr', '1', '-profile:v', 'baseline'],
  libx264: ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-x264-params', 'repeat-headers=1:sliced-threads=1',
    '-profile:v', 'baseline'],
};

/** Direct3D 11 adapters as ffmpeg numbers them, with their vendor. */
export function listAdapters(ffmpeg) {
  const adapters = [];
  for (let index = 0; index < 4; index++) {
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-v', 'verbose', '-init_hw_device', `d3d11va=probe:${index}`,
      '-f', 'lavfi', '-i', 'nullsrc=s=64x64', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const text = `${probe.stderr || ''}`;
    const used = /Using device ([0-9a-f]{4}):([0-9a-f]{4}) \(([^)]*)\)/i.exec(text);
    if (!used) break;
    if (/Failed to create Direct3D device/i.test(text)) continue;
    adapters.push({ index, vendor: VENDORS[used[1].toLowerCase()] || 'other', name: used[3] });
  }
  return adapters;
}

/** What to try on this PC, best first (or only what --encoder asked for). */
export function candidates(adapters, forced = 'auto') {
  const of = (vendor) => adapters.find((a) => a.vendor === vendor);
  const list = [];
  const nvidia = of('nvidia');
  const amd = of('amd');
  const intel = of('intel');
  if (nvidia) list.push({ encoder: 'h264_nvenc', mode: 'gpu', adapter: nvidia.index, gpu: nvidia.name });
  if (amd) list.push({ encoder: 'h264_amf', mode: 'download', adapter: amd.index, gpu: amd.name });
  if (intel) list.push({ encoder: 'h264_qsv', mode: 'qsv', adapter: intel.index, gpu: intel.name });
  if (amd) list.push({ encoder: 'h264_amf', mode: 'nv12', adapter: amd.index, gpu: amd.name });
  if (intel) list.push({ encoder: 'h264_qsv', mode: 'nv12', adapter: intel.index, gpu: intel.name });
  list.push({ encoder: 'libx264', mode: 'cpu', adapter: null, gpu: 'CPU' });
  return forced && forced !== 'auto' ? list.filter((c) => c.encoder === forced) : list;
}

/** The capture-to-encoder part of the filter graph for a backend (after gfxcapture's own crop and scale). */
export function captureTail(backend) {
  if (backend.mode === 'gpu') return '';
  if (backend.mode === 'download') return ',hwdownload,format=bgra';
  if (backend.mode === 'qsv') return ',hwmap=derive_device=qsv,format=qsv,vpp_qsv=format=nv12';
  if (backend.mode === 'nv12') return ',hwdownload,format=bgra,format=nv12';
  return ',hwdownload,format=bgra,format=yuv420p';
}

/** ffmpeg arguments that put the capture on the backend's adapter (gfxcapture uses the filter device). */
export function deviceArgs(backend) {
  return backend.adapter == null ? [] : ['-init_hw_device', `d3d11va=cap:${backend.adapter}`, '-filter_hw_device', 'cap'];
}

/** A few synthetic frames through the backend's real path: does this encoder work here at all? */
function verify(ffmpeg, backend) {
  const source = backend.mode === 'gpu' || backend.mode === 'qsv'
    ? 'color=c=black:s=320x240:r=30,format=bgra,hwupload'
    : 'color=c=black:s=320x240:r=30,format=bgra';
  const tail = backend.mode === 'qsv' ? ',hwmap=derive_device=qsv,format=qsv,vpp_qsv=format=nv12'
    : backend.mode === 'nv12' ? ',format=nv12' : backend.mode === 'cpu' ? ',format=yuv420p' : '';
  const args = ['-hide_banner', '-loglevel', 'error', ...deviceArgs(backend), '-filter_complex', `${source}${tail}[v]`,
    '-map', '[v]', '-frames:v', '5', ...ENCODE_ARGS[backend.encoder], '-b:v', '1000k', '-bf', '0', '-g', '30', '-f', 'null', '-'];
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ya terminó */ } }, 15000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, error: err.trim().split('\n').pop() || null }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

/** The first backend that works on this PC, after `skip` (the ones that already failed for real). */
export async function chooseBackend(ffmpeg, { forced = 'auto', skip = [], log = console.log } = {}) {
  const adapters = process.platform === 'win32' ? listAdapters(ffmpeg) : [];
  for (const backend of candidates(adapters, forced)) {
    const key = `${backend.encoder}/${backend.mode}`;
    if (skip.includes(key)) continue;
    const check = await verify(ffmpeg, backend);
    if (check.ok) {
      log(`[vídeo] codificador: ${backend.encoder} (${backend.mode}) en ${backend.gpu}`);
      return { ...backend, key, adapters };
    }
    log(`[vídeo] ${backend.encoder} (${backend.mode}) no funciona aquí: ${check.error}`);
  }
  return null;
}
