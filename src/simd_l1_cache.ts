export class VectorRingBufferCache {
    private capacity: number = 1024;
    private dimensions: number = 768;
    private vectors: Float32Array;
    private nodeIds: string[] = [];
    private pointer: number = 0;
    private count: number = 0;
    constructor(capacity = 1024, dimensions = 768) {
        this.capacity = capacity;
        this.dimensions = dimensions;
        this.vectors = new Float32Array(this.capacity * this.dimensions);
    }
    public insert(nodeId: string, vector: Float32Array): void {
        const offset = this.pointer * this.dimensions;
        this.vectors.set(vector, offset);
        this.nodeIds[this.pointer] = nodeId;
        this.pointer = (this.pointer + 1) % this.capacity;
        if (this.count < this.capacity)
            this.count++;
    }
    public findNearest(query: Float32Array): {
        nearestId: string | null;
        similarity: number;
    } {
        let maxSim = -1.0;
        let bestId: string | null = null;
        for (let i = 0; i < this.count; i++) {
            let dot = 0.0;
            const offset = i * this.dimensions;
            const limit = this.dimensions - (this.dimensions % 4);
            for (let d = 0; d < limit; d += 4) {
                dot += this.vectors[offset + d] * query[d] +
                    this.vectors[offset + d + 1] * query[d + 1] +
                    this.vectors[offset + d + 2] * query[d + 2] +
                    this.vectors[offset + d + 3] * query[d + 3];
            }
            for (let d = limit; d < this.dimensions; d++) {
                dot += this.vectors[offset + d] * query[d];
            }
            if (dot > maxSim) {
                maxSim = dot;
                bestId = this.nodeIds[i];
            }
        }
        return { nearestId: bestId, similarity: maxSim };
    }
}
export const SimdVectorRingBuffer = VectorRingBufferCache;
