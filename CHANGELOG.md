# Changelog

## Unreleased

- Explain blocked file/shell actions versus chat; surface settings in stopped-state guidance and add start/stop plus an explanation to the sandbox menu.
- Save a user-global default runtime from `/sandbox`; explicit startup flags override it and session-local runtime switching remains separate.

- Simplified commands to `/sandbox`, `/sandbox start`, and `/sandbox stop`; status, runtime/network settings, and confirmed maintenance live in the `/sandbox` menu.
- Starting with a missing image offers a confirmed build; unattended startup never builds implicitly.
- Explicit Podman/Apple Container runtime selection via startup flag or stopped-session menu; no automatic fallback.
- Runtime-specific lifecycle, builds, cleanup, hardening, and ownership-aware shutdown.
- Live CPU/memory indicator with bounded, non-overlapping polling and safe unavailable states; status also shows process count, limits, and launch duration.
- Experimental Apple adapter targets container 1.7.1; backend differences and metrics scope are documented, with an opt-in Mac smoke test.

## 0.1.0

- Initial Podman-first execution sandbox with live workspace mounts.
- Container-backed read, write, edit, and bash; unsupported tools fail closed.
- Session lifecycle, shared toolbox image, optional offline networking, and targeted cleanup.
- Unit tests and opt-in Podman integration test.
