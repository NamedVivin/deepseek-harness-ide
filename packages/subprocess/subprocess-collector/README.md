# @deepseek-ai/dsh-subprocess-collector

English | [中文](README.zh.md)

Provider-neutral collected-output implementation for ordinary subprocess providers. `OutputCollector` retains an exact byte-bounded tail, gives independent readers whole-stream offsets, and optionally writes the complete stream to a private spill file. `collectReadable()` adds the clean-EOF drain lifecycle used by Node `Readable` providers.

Spill paths have two states. `provisionalSpillPath` is provider-private while bytes may still arrive. `readFrom()` publishes a spill path only after `finalize()` has closed a cleanly drained file; `fail()` handles transport errors, early close, and bounded-drain cancellation by withholding and deleting the provisional file while keeping the tail readable. Open, write, and final-close failures disable optional spill recovery without losing the bounded tail.

Providers call `push()` with exact bytes, settle their process outcome only after collector drain/finalization, and keep the reader reachable after process exit. A provider that uses its own framed transport can drive `OutputCollector` directly; a provider with a Node stream uses `collectReadable()`.

## Model Experience

Indirectly, through subprocess Consumers, which decide how collected text, truncation, and complete spill recovery are rendered.

#### KV Cache effect

No direct invalidation; Consumers own any model-request prefix or result changes.

## Known Limitations and Deferred Work

- Spill files remain in the provider's private temporary area after successful publication so consumers can read them; deployment-level retention and deletion policy remains separate from collector finalization.
