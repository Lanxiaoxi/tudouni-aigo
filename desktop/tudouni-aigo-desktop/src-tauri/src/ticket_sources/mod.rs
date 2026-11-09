//! Ticket Sources: adapters that turn changes in the outside world into
//! ticket inbox files (`docs/design/ticket-sources.md`).
//!
//! The layer is split at one seam, `probes::run_probe`: a probe knows how to
//! *look* at one kind of place and returns the current items; everything after
//! that (diff against the last snapshot, baseline, limit, templates, the inbox
//! write, the state file) is the same for every kind and lives in the other
//! modules. Adding a kind therefore touches `probes/` only.
//!
//! The layer only ever writes `inbox/` and its own two files. It never touches
//! `tickets.json`, so the "exactly one writer" rule of `tickets_data` holds.

mod config;
mod diff;
mod emit;
mod scan;
mod state;
mod template;

pub(crate) mod commands;
pub(crate) mod filter;
pub(crate) mod probes;
