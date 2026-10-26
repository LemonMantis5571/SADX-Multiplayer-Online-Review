// Direct connection (WebRTC) for viewers, next to the WebSocket.
//
// Through the Cloudflare tunnel every frame and every button press goes browser
// -> Cloudflare -> this PC over TCP. When the viewer's browser can reach this PC
// directly (most home routers allow it with STUN), a WebRTC connection carries
// the video as RTP over UDP and the controls on an unordered data channel without
// retransmissions: no detour, and a lost packet doesn't hold up the ones behind
// it. Signaling (one offer, one answer, ICE gathered up front) goes over the
// room's WebSocket, which keeps everything else (seats, chat, sound). If the
// connection doesn't come up, or drops, the viewer stays on the WebSocket video.
//
// werift (pure JavaScript) is an optional dependency: without it the room simply
// doesn't offer this.
let werift = null;

export async function loadWebRtc() {
  try {
    werift = await import('werift');
  } catch {
    werift = null;
  }
  return werift !== null;
}

export const rtcAvailable = () => werift !== null;

const RTP_PAYLOAD = 1150;        // stays under typical path MTUs with SRTP and IP/UDP headers
const GATHER_TIMEOUT_MS = 4000;  // STUN answers within a second or two; don't wait forever for it
const H264_PARAMETERS = 'profile-level-id=42e028;packetization-mode=1;level-asymmetry-allowed=1'; // baseline, up to level 4

/** NAL units of an Annex B access unit, without start codes (AUDs dropped: RTP marks frame ends itself). */
export function nalUnits(au) {
  const units = [];
  let start = -1;
  for (let i = 0; i + 2 < au.length; i++) {
    if (au[i] !== 0 || au[i + 1] !== 0) continue;
    let header = -1;
    if (au[i + 2] === 1) header = i + 3;
    else if (au[i + 2] === 0 && i + 3 < au.length && au[i + 3] === 1) header = i + 4;
    if (header < 0) continue;
    if (start >= 0) units.push(au.subarray(start, i));
    start = header;
    i = header - 1;
  }
  if (start >= 0 && start < au.length) units.push(au.subarray(start));
  return units.filter((nal) => nal.length && (nal[0] & 0x1f) !== 9);
}

/** RTP payloads for one access unit (RFC 6184): small NAL units as they are, big ones in FU-A fragments. */
export function packetize(au, mtu = RTP_PAYLOAD) {
  const payloads = [];
  for (const nal of nalUnits(au)) {
    if (nal.length <= mtu) { payloads.push(nal); continue; }
    const indicator = (nal[0] & 0xe0) | 28;
    const type = nal[0] & 0x1f;
    for (let offset = 1; offset < nal.length; offset += mtu - 2) {
      const end = Math.min(nal.length, offset + mtu - 2);
      const header = type | (offset === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0);
      payloads.push(Buffer.concat([Buffer.from([indicator, header]), nal.subarray(offset, end)]));
    }
  }
  return payloads;
}

export class RtcLink {
  constructor({ log = console.log, onMessage = () => {}, onState = () => {} } = {}) {
    if (!werift) throw new Error('WebRTC no está disponible (falta werift)');
    this.log = log;
    this.onMessage = onMessage;
    this.onState = onState;
    this.pc = null;
    this.track = null;
    this.channel = null;
    this.state = 'new';
    this.sequence = Math.floor(Math.random() * 65536);
    this.startedAt = Date.now();
    this.needKey = true;
    this.framesSent = 0;
    this.keyRequests = 0;
  }

  get connected() {
    return this.state === 'connected';
  }

  /** Builds the peer (video out, controls in) and returns the offer with its ICE candidates in it. */
  async offer() {
    const { RTCPeerConnection, MediaStreamTrack, useH264 } = werift;
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      codecs: { video: [useH264({ parameters: H264_PARAMETERS })], audio: [] },
    });
    this.pc = pc;
    this.track = new MediaStreamTrack({ kind: 'video' });
    const transceiver = pc.addTransceiver(this.track, { direction: 'sendonly' });
    // The browser lost a picture it can't recover from: wait for the next keyframe (one a second).
    transceiver.sender.onPictureLossIndication.subscribe(() => { this.needKey = true; this.keyRequests += 1; });
    this.channel = pc.createDataChannel('pad', { ordered: false, maxRetransmits: 0 });
    this.channel.onMessage.subscribe((data) => this.onMessage(typeof data === 'string' ? data : data.toString('utf8')));
    pc.connectionStateChange.subscribe((state) => {
      this.state = state;
      if (state === 'connected') this.needKey = true;
      this.onState(state);
    });

    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
        pc.iceGatheringStateChange.subscribe((state) => { if (state === 'complete') { clearTimeout(timer); resolve(); } });
      });
    }
    return pc.localDescription.sdp;
  }

  async answer(sdp) {
    if (!this.pc) throw new Error('no hay oferta');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: String(sdp) });
  }

  /** One access unit out as RTP; the 90 kHz timestamp follows the wall clock, the marker ends the frame. */
  sendFrame(au, key) {
    if (!this.connected || !this.track) return false;
    if (this.needKey && !key) return false;
    this.needKey = false;
    const { RtpPacket, RtpHeader } = werift;
    const timestamp = Math.round((Date.now() - this.startedAt) * 90) >>> 0;
    const payloads = packetize(au);
    payloads.forEach((payload, i) => {
      const header = new RtpHeader({
        sequenceNumber: this.sequence,
        timestamp,
        marker: i === payloads.length - 1,
        payloadType: 96,
      });
      this.sequence = (this.sequence + 1) & 0xffff;
      this.track.writeRtp(new RtpPacket(header, payload));
    });
    this.framesSent += 1;
    return true;
  }

  close() {
    this.state = 'closed';
    try { this.track?.stop(); } catch { /* ya parado */ }
    this.pc?.close().catch(() => {});
    this.pc = null;
  }
}
