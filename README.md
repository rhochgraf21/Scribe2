# Scribe — browser edition

Live English captions with inline speaker labels. React, shadcn components, Atkinson Hyperlegible, ONNX Runtime Web, and locally imported Nemotron models. No inference backend, audio uploads, recording, or transcript storage. Refresh clears the conversation and imported file references.

## Use

Open the HTTPS site in a browser with WebGPU support. Select **Download models** to fetch the pinned, approved models (about 912 MB), or select **Import models** and choose your `browser-models` folder containing `asr/` and `diar/`. Click **Load local models**, choose your microphone, then **Start captions**. Each device needs its own copy of the approved models. Import verifies exact sizes and hashes before inference. Unrelated files are ignored; missing, duplicate, or changed required files are rejected. Files are never uploaded. Downloads stream through 4 MiB integrity checks into browser storage, without holding entire model arrays in JavaScript. Block hashes were derived from the existing model files after verifying their pinned full-file hashes. Completed downloads are restored and verified on refresh; interrupted files restart, while completed files are reused. Imports remain in memory. Use **Delete saved models** to clear downloaded model data; browser storage limits or eviction may require downloading again.

Existing local installations can copy their `browser-models` folder to another device. The approved repositories, immutable revisions, filenames, and integrity hashes are in `config/browser-models.json`. Downloads begin only when you click **Download models**. Progress and cancellation are available. Download requests go to Hugging Face and its approved CDN; credentials and referrer are omitted. Models are approximately 912 MB; verification and inference need additional RAM. Smaller devices may not keep up.

WebGPU runs speech encoding and speaker detection in separate workers; they still share GPU resources. Token decoding runs on CPU. CPU-only mode is available, but GitHub Pages does not provide our local server's cross-origin isolation headers, so WASM uses one thread. Speaker assignments and word boundaries are approximate. If speaker detection falls over 15 seconds behind it stops, while captions continue with a visible warning.

## Build and publish

Node 24 or newer. Install with `npm ci --ignore-scripts`, run `npm audit`, `npm test`, and `npm run build`. Serve `browser-dist` using HTTPS (localhost is also usable for development). Do not open HTML directly with `file://`.

Choose **GitHub Actions** in repository Settings → Pages. The included workflow installs locked dependencies, audits them, runs tests, builds, and publishes `browser-dist` on changes to main. Both the root and browser.html open the same app. The production bundle includes runtime and font assets, but no models or native backend.

## Privacy and security

The website and source are public. GitHub receives ordinary site/asset requests; Hugging Face receives model download requests when requested. Microphone samples and captions stay in browser memory; no analytics or telemetry is added. HTTPS and browser microphone permission are required. Imported models must match the bundled pinned manifest; this is an integrity check, not a guarantee that an ML runtime has no vulnerabilities. Dependencies are locked; run `npm audit --audit-level=high` before each deployment.

The page uses a restrictive CSP; inference workers restrict fetch to local imported models and same-origin runtime assets. Pages cannot reproduce all the custom security headers of the original local server. Do not put secrets in this repository. The JavaScript argmax uses the original joint graph, so users do not need a locally generated graph.

Third-party source licenses and provenance are in `vendor/` and `src/browser/ASR-LICENSE`. Model licenses remain those of their respective publishers; model binaries are not redistributed here.

## CPU model choice and speaker names

Choose **Nemotron 600M INT8 · CPU** before downloading/loading to use the pinned `danielbodart/nemotron-speech-600m-onnx` INT8-dynamic export. This selection forces CPU execution for both speech and speaker detection. Its combined download is about 1,040 MB; this is file size, not peak RAM. Phone performance is experimental. The original Nemotron 3.5 model remains the default. Reload the page to switch models after loading; previously downloaded files, including the shared speaker model, are reused.

For folder import, put the CPU repository's `int8-dynamic/`, `shared/`, and `config.json` inside `asr-int8/`, alongside the existing `diar/` folder. Exact revisions, file sizes, and hashes are in `config/cpu-model.json`. CPU weights originate from NVIDIA's Nemotron Speech Streaming 0.6B, distributed under CC-BY-4.0; attribution: NVIDIA (base model), Daniel Bodart (ONNX export). Model binaries are downloaded from Hugging Face, not bundled with the site.

Click or tap an inline speaker label, type a name, and save (Enter) or cancel (Escape). Naming works while listening and while text is held. Names follow speaker IDs across live caption corrections and appear in **Export text**. They are cleared with the conversation, on starting a new conversation, or on refresh; they do not identify people across sessions.

## Performance diagnostics

Expand **Performance diagnostics** to see configured threads, whether browser isolation allows multithreading, per-worker queued audio and compute capacity, and stage timings in milliseconds per audio second. The first/slowest encoder calls help distinguish warm-up from sustained work. Measurements are session averages; separate workers overlap, so their timings must not be summed to estimate end-to-end latency. Model file sizes and JavaScript heap sizes are not measurements of total process memory.

**Download diagnostics** exports only timing counters, configuration, and browser details—no audio, captions, or speaker names. Before loading, the CPU thread budget can be set to 1, 2, 4, 6, or 8 (bounded by reported cores and browser isolation). More threads are not guaranteed to help. Compare the same audio and allow for warm-up; refresh before changing a loaded runtime's settings. The local server provides isolation headers; GitHub Pages still limits this setup to one WASM thread.

For an explicit local benchmark build, run `SCRIBE_BROWSER_BENCHMARK=1 npm run build`. Its `browser-benchmark.html` exposes `runCpuBenchmark` for a test harness, using already verified models in browser storage. Production builds omit this entry point.

CPU mode defaults to separate workers with a 6-thread total budget: two for speech and four for speaker detection when at least six logical cores and browser multithreading are available. Smaller devices share a reduced budget; non-isolated pages use one shared thread. The pinned INT8 speech export uses fixed input dimensions to reduce runtime overhead without changing its audio chunk size or weights.

Speaker detection uses 11-frame chunks (880 ms of new audio) with four lookahead frames (320 ms), for 1.20 s of input buffering. Recent history is capped at 200 frames (16 seconds), down from 264 frames (21.12 seconds). On overflow, 158 frames move into the separate speaker-identity cache, preserving the original 42-frame recent-history overlap; the identity cache remains at 264 frames. This shorter history is an experimental tuning choice; evaluate speaker accuracy on representative conversations. Diagnostics show the chunk size, lookahead, history cap, and call count. The benchmark accepts `speakerChunkFrames` (9, 11, or 12) and `speakerHistoryFrames` (150, 200, or 264) to compare settings. Speech chunking, threads, and queue limits are unchanged.

Speaker diagnostics split the total detection time into network execution (including ONNX input/output handling), speaker-cache updates, and remaining tensor/host work. These are components of the total, not extra costs. Timing counters reset for each recording and are included in diagnostic exports.

A local 90-second comparison (the same 45-second fixture repeated twice, 2 speech + 4 speaker threads, 880 ms chunks, 16-second history) measured 71.24 s of speaker network execution versus about 25 ms of cache/tensor work. Fixing only `batch_size=1` gave no meaningful gain: 75.73 s versus 75.69 s end-to-end, with identical final captions and speaker assignments. Buffer reuse was therefore not pursued. The fixed-batch experiment remains off by default and is available to the benchmark as `speakerFixedBatch: true`; these results are not phone benchmarks or accuracy validation.

For operator-level CPU profiling, the benchmark accepts `speakerRuntimeOptions: { enableProfiling: true }`. At stop, the worker aggregates ONNX's console trace into per-operator and per-node call counts, total/max time, and totals after the first 46 model calls (about 40 seconds at the default chunk size). Trace durations are converted from microseconds to milliseconds; tensor contents are not retained. Profiling is off in normal use, and its timings must not be compared directly with unprofiled throughput. Run profiles in a fresh benchmark session.

The benchmark also accepts boolean `enableCpuMemArena` and `enableMemPattern` in `speakerRuntimeOptions`. Compare each separately and together against the same baseline, with profiling off and fresh sessions; verify captions and speaker assignments. These options affect allocations inside ONNX, distinct from the JavaScript tensor/cache timings in diagnostics. Unsupported runtime option names are rejected.

The 90-second operator profile recorded 102 speaker calls and 72,930 kernel events: `MatMulNBits` accounted for 77.1% of summed kernel time, `MatMul` 8.8%, and `BiasGelu` 3.8%. The first unprofiled comparison measured defaults 1.02×, memory arena 1.16×, memory patterns 1.12×, and both 1.10×. Repeating arena then defaults reversed the result (1.11× versus 1.14×); there was no repeatable speed gain, so both flags remain off. All final captions and speaker assignments matched across these runs. This fixture is not an accuracy evaluation, and these desktop timings do not establish phone performance.

Summarize a captured report with `node scripts/summarize-speaker-runtime.mjs /path/to/report.json`; it reports operator shares and checks that compared runs have the same workload and final output, without printing transcript text. Diagnostics display the active memory flags. In the UI, the former “Network execution” stage is now called “Model computation.”

The `accuracy_level=4` experiment uses `scripts/make-speaker-int8-activation-variant.cjs SOURCE OUTPUT` to generate a separate graph. It adds that attribute to all 127 8-bit, block-size-32 `MatMulNBits` nodes and asserts that removing those attributes recovers the original decoded graph exactly. External weights and verified browser storage are unchanged. The benchmark accepts `speakerAccuracyLevel: 4`, `speakerGraphBase64`, and its expected `speakerGraphSha256`; it checks the digest and substitutes the graph only in the in-memory benchmark file map. This override is absent from the production entry point. Level 0 uses the original graph.

On the 90-second fixture, the original ran at 1.099× realtime and level 4 at 1.072× (about 2.5% slower in this single comparison). Captions/speaker assignments matched, as did a benchmark-only FNV-1a fingerprint across 72,000 raw output values. This is consistent with fallback to the existing float computation path, not proof of which internal kernel ran. The experiment showed no benefit and was not enabled in normal use. The benchmark records the variant hash, output fingerprint, and value count for reproducibility; ordinary recordings do not compute the fingerprint.
