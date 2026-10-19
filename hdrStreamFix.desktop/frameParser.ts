/*
 * HdrStreamFix — parses the helper's stdout stream into frames.
 * Chunk = 16-byte header (magic, two numbers, seq; little-endian u32) + body.
 * Video: "HDRF", width, height + NV12 (w*h*3/2). Audio: "HDRA", frames + interleaved stereo float32.
 * Two buffers are reused alternately so the last complete frame is never overwritten while it is
 * being handed to the renderer, and we don't allocate megabytes per frame.
 */

export interface Frame {
    seq: number;
    width: number;
    height: number;
    data: Buffer;
}

export class FrameParser {
    private header = Buffer.alloc(16);
    private headerFill = 0;
    private body: Buffer | null = null;
    private bodyFill = 0;
    private pool: Buffer[] = [];
    private poolIndex = 0;
    private width = 0;
    private height = 0;
    private seq = 0;

    /**
     * @param magic   4-byte tag every chunk starts with ("HDRF" video, "HDRA" audio)
     * @param bodySize body length from the header's two numbers
     */
    constructor(
        private onFrame: (f: Frame) => void,
        private magic: string,
        private bodySize: (a: number, b: number) => number
    ) { }

    push(chunk: Buffer) {
        let off = 0;
        while (off < chunk.length) {
            if (!this.body) {
                const n = Math.min(16 - this.headerFill, chunk.length - off);
                chunk.copy(this.header, this.headerFill, off, off + n);
                this.headerFill += n;
                off += n;
                if (this.headerFill < 16) return;

                if (this.header.toString("latin1", 0, 4) !== this.magic) throw new Error("HdrStreamFix: corrupt frame stream");
                this.width = this.header.readUInt32LE(4);
                this.height = this.header.readUInt32LE(8);
                this.seq = this.header.readUInt32LE(12);
                const size = this.bodySize(this.width, this.height);
                if (!size || size > 8192 * 8192 * 4) throw new Error(`HdrStreamFix: bad frame size ${this.width}x${this.height}`);

                if (this.pool.length !== 2 || this.pool[0].length !== size)
                    this.pool = [Buffer.allocUnsafe(size), Buffer.allocUnsafe(size)];
                this.body = this.pool[this.poolIndex];
                this.bodyFill = 0;
            } else {
                const n = Math.min(this.body.length - this.bodyFill, chunk.length - off);
                chunk.copy(this.body, this.bodyFill, off, off + n);
                this.bodyFill += n;
                off += n;
                if (this.bodyFill === this.body.length) {
                    const frame = { seq: this.seq, width: this.width, height: this.height, data: this.body };
                    this.poolIndex ^= 1;
                    this.body = null;
                    this.headerFill = 0;
                    this.onFrame(frame);
                }
            }
        }
    }
}
