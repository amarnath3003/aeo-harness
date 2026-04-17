/**
 * LlamaEngine — node-llama-cpp wrapper for gemma-3-1b-it
 *
 * Wraps node-llama-cpp to expose a simple inference interface
 * that accepts dynamic thread counts from the AEO Compute Allocator.
 *
 * Model: gemma-3-1b-it (GGUF format, Q4_K_M recommended for mobile simulation)
 *
 * Setup:
 *   1. Download: huggingface-cli download bartowski/gemma-3-1b-it-GGUF
 *                  gemma-3-1b-it-Q4_K_M.gguf --local-dir ./models
 *   2. Set env: MODEL_PATH=./models/gemma-3-1b-it-Q4_K_M.gguf
 */

import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';

export class LlamaEngine extends EventEmitter {
  constructor() {
    super();
    this.llama = null;
    this.model = null;
    this.context = null;
    this.session = null;
    this.currentThreads = 4;
    this.isLoaded = false;
    this.isGenerating = false;
    this.modelPath = process.env.MODEL_PATH ||
      path.join(process.cwd(), 'models', 'gemma-3-1b-it-Q4_K_M.gguf');
  }

  async load() {
    console.log(`[LlamaEngine] Loading model from: ${this.modelPath}`);
    try {
      this.llama = await getLlama();

      this.model = await this.llama.loadModel({
        modelPath: this.modelPath,
        // GPU layers = 0 for CPU-only edge simulation
        gpuLayers: parseInt(process.env.GPU_LAYERS ?? '0'),
      });

      // Initial context with default threads
      await this._createContext(4);

      this.isLoaded = true;
      console.log(`[LlamaEngine] Model loaded successfully.`);
      console.log(`[LlamaEngine] CPU cores available: ${os.cpus().length}`);
      return true;
    } catch (err) {
      console.error('[LlamaEngine] Failed to load model:', err.message);
      console.warn('[LlamaEngine] Running in MOCK mode (model not found).');
      this.isLoaded = false;
      return false;
    }
  }

  async _createContext(threads) {
    if (this.context) {
      await this.context.dispose().catch(() => {});
    }
    const cpuCount = os.cpus().length;
    const safeThreads = Math.min(threads, cpuCount);

    this.context = await this.model.createContext({
      threads: safeThreads,
      contextSize: parseInt(process.env.CONTEXT_SIZE ?? '2048'),
      batchSize: 512,
    });

    this.session = new LlamaChatSession({
      contextSequence: this.context.getSequence()
    });

    this.currentThreads = safeThreads;
    console.log(`[LlamaEngine] Context (re)created with ${safeThreads} threads.`);
  }

  /**
   * Run inference with a given thread count (from AEO Compute Allocator).
   *
   * Metrics captured:
   *   - prompt_eval_time_sec: time for the model to process the input tokens
   *   - time_to_first_token_sec: wall-clock to first generated token
   *   - generation_rate_tps: tokens/second during generation
   *   - total_generation_time_sec: end-to-end
   *   - power_proxy_core_seconds: total_time * threads
   */
  async infer(prompt, threads = 4, options = {}) {
    // If threads changed, we need to recreate the context
    if (this.isLoaded && threads !== this.currentThreads) {
      await this._createContext(threads);
    }

    const {
      maxTokens = 512,
      systemPrompt = 'You are a concise wilderness survival AI assistant. Give direct, actionable answers.',
      onToken = null, // streaming callback
    } = options;

    // Intentionally pass raw user text; LlamaChatSession handles the chat template.
    void systemPrompt;

    const inferStart = process.hrtime.bigint();
    let firstTokenTime = null;
    let tokenCount = 0;
    let response = '';

    if (!this.isLoaded) {
      // MOCK mode — simulate realistic latencies for development/demo
      return this._mockInfer(prompt, threads, inferStart, { onToken });
    }

    this.isGenerating = true;

    try {
      const promptEvalStart = process.hrtime.bigint();

      await this.session.prompt(prompt, {
        maxTokens,
        onToken: (tokenIds) => {
          let chunk = '';
          if (typeof tokenIds === 'string') {
            chunk = tokenIds;
          } else {
            const detokenized = this.model.detokenize(tokenIds);
            chunk = typeof detokenized === 'string'
              ? detokenized
              : Buffer.from(detokenized).toString('utf8');
          }

          const now = process.hrtime.bigint();
          if (firstTokenTime === null) {
            firstTokenTime = now;
            // Emit prompt eval complete
            const promptEvalMs = Number(now - promptEvalStart) / 1e6;
            this.emit('prompt_eval_done', promptEvalMs);
          }
          response += chunk;
          tokenCount += ArrayBuffer.isView(tokenIds) ? tokenIds.length : 1;
          if (onToken) onToken(chunk);
          this.emit('token', chunk);
        }
      });

    } finally {
      this.isGenerating = false;
    }

    const endTime = process.hrtime.bigint();
    const promptEvalTimeSec = firstTokenTime
      ? Number(firstTokenTime - inferStart) / 1e9
      : 0;
    const generationTimeSec = firstTokenTime
      ? Number(endTime - firstTokenTime) / 1e9
      : 0;
    const totalTimeSec = Number(endTime - inferStart) / 1e9;
    const generationRateTps = generationTimeSec > 0 ? tokenCount / generationTimeSec : 0;

    return {
      response,
      tokenCount,
      threads,
      metrics: {
        prompt_eval_time_sec: parseFloat(promptEvalTimeSec.toFixed(4)),
        time_to_first_token_sec: parseFloat(promptEvalTimeSec.toFixed(4)),
        generation_rate_tps: parseFloat(generationRateTps.toFixed(2)),
        total_generation_time_sec: parseFloat(totalTimeSec.toFixed(4)),
        power_proxy_core_seconds: parseFloat((totalTimeSec * threads).toFixed(4))
      }
    };
  }

  /**
   * Mock inference for development without a model file.
   * Simulates realistic latency curves based on thread count.
   */
  async _mockInfer(prompt, threads, inferStart, options = {}) {
    const { onToken = null } = options;

    const normalizedPrompt = String(prompt ?? '').trim().toLowerCase();

    const mockResponses = {
      hi: 'Hello. Tell me your situation and I will give a concise survival plan.',
      hello: 'Hello. Tell me your situation and I will give a concise survival plan.',
      hey: 'Hey. Share your scenario and I will give a clear next-step plan.',
      greetings: 'Greetings. Describe your environment and constraints for a focused plan.',
      thanks: 'You are welcome. If you want, I can give a compact checklist for your next step.',
      thank: 'You are welcome. If you want, I can give a compact checklist for your next step.',
      wound: "Apply direct pressure immediately with clean cloth. Elevate the limb above heart level. If arterial bleeding, apply tourniquet 2-3 inches above wound. Do not remove once applied. Mark time of application.",
      fire: "Use the bow-drill or flint-and-steel method. Prepare tinder bundle (dry grass, bark shreds), kindling (pencil-sized sticks), and fuel wood. Strike sparks into tinder, blow gently, add kindling progressively.",
      water: "Prioritize moving water over stagnant. Filter through cloth, then boil 1 minute (3 minutes above 2000m). Look for animal trails leading downhill — they often lead to water sources.",
      shelter: "Prioritize: wind block, insulation from ground, rain cover. Lean-to with debris wall takes 20 minutes. Debris hut (leaves/pine needles 3ft thick) provides excellent insulation.",
      knot: "Square knot: right over left, left over right. Pull both ends firmly. Used for joining two ropes of equal diameter. Not suitable for critical load-bearing applications.",
      default: "In wilderness survival, prioritize in this order: 1) Signal for rescue, 2) Shelter from elements, 3) Find water (dehydration kills in 3 days), 4) Find food (starvation takes weeks). Stay calm and think before acting."
    };

    let mockText = mockResponses.default;
    for (const [key, val] of Object.entries(mockResponses)) {
      if (normalizedPrompt.includes(key)) { mockText = val; break; }
    }

    if (mockText === mockResponses.default) {
      const isShortConversational = normalizedPrompt.length > 0 && normalizedPrompt.length <= 32;
      const hasQuestion = normalizedPrompt.includes('?');
      const conversationalPattern = /\b(yo|sup|hola|how are you|good morning|good evening|good night|what'?s up|whats up)\b/;
      if (isShortConversational || hasQuestion || conversationalPattern.test(normalizedPrompt)) {
        mockText = 'I can help with survival guidance. Ask about shelter, water, fire, wounds, or navigation for a concise answer.';
      }
    }

    // Simulate realistic token-by-token generation with thread-dependent speed
    // More threads = faster generation (diminishing returns after 4)
    const speedFactor = Math.min(threads, 6) / 4; // 4 threads = baseline
    const msPerWord = Math.round(20 / speedFactor);
    const promptEvalMs = 200 + (800 / threads); // prompt eval faster with more threads
    const words = mockText.split(' ');
    const tokenCount = Math.ceil(words.length * 1.3);

    // Simulate prompt eval phase
    await new Promise(r => setTimeout(r, promptEvalMs));
    const firstTokenTime = process.hrtime.bigint();
    this.emit('prompt_eval_done', promptEvalMs);

    // Simulate streaming token generation
    for (const word of words) {
      await new Promise(r => setTimeout(r, msPerWord + Math.random() * 10));
      const chunk = `${word} `;
      if (onToken) onToken(chunk);
      this.emit('token', chunk);
    }

    const endTime = process.hrtime.bigint();
    const promptEvalSec = Number(firstTokenTime - inferStart) / 1e9;
    const genTimeSec = Number(endTime - firstTokenTime) / 1e9;
    const totalTimeSec = Number(endTime - inferStart) / 1e9;
    const tps = genTimeSec > 0 ? tokenCount / genTimeSec : 0;

    return {
      response: mockText,
      tokenCount,
      threads,
      isMock: true,
      metrics: {
        prompt_eval_time_sec: parseFloat(promptEvalSec.toFixed(4)),
        time_to_first_token_sec: parseFloat(promptEvalSec.toFixed(4)),
        generation_rate_tps: parseFloat(tps.toFixed(2)),
        total_generation_time_sec: parseFloat(totalTimeSec.toFixed(4)),
        power_proxy_core_seconds: parseFloat((totalTimeSec * threads).toFixed(4))
      }
    };
  }

  async dispose() {
    if (this.context) await this.context.dispose().catch(() => {});
    if (this.model) await this.model.dispose().catch(() => {});
    if (this.llama) await this.llama.dispose().catch(() => {});
  }
}
