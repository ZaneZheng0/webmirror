# Metrics

## Baseline

- Date: 2026-07-18
- Repository verify: passed
- Unit tests: 2
- Workspace builds: 7
- Fixture health check: HTTP 200
- Basic fixture: HTTP 200, 701-byte HTML response
- Full verify wall time: approximately 27 seconds on the development machine

## Required Measurements

- `preflight_ms`
- `attach_ms`
- `discovery_ms`
- `download_ms`
- `rewrite_ms`
- `preview_start_ms`
- `fast_validation_ms`
- `ready_ms`
- `peak_memory_mb`
- `asset_count`
- `cache_hit_count`
- `retry_count`
- `missing_asset_count`
- `unexpected_remote_request_count`
