// Package ui hosts the Wails-driven desktop UI.
//
// T8 placeholder: the GUI binary's `lcmbar gui` subcommand calls Run, which
// is where Wails takes over. The actual `wails3.NewApp(...).Run()` lands in
// the T8 follow-up alongside the React frontend; for now we keep a real
// symbol so the GUI build compiles and gives a clear "not implemented yet".
//
// The Go-side service surface that Wails will bind is already in
// internal/ui/services — those are stable across the T8 ↔ T8.1 boundary.
package ui

import "errors"

func Run() error {
	return errors.New("ui: GUI not implemented yet (T8 — service surface ready in internal/ui/services)")
}
