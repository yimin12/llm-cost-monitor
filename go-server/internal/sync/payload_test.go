package sync

import "testing"

// Verifies the canonical sync_event_id input matches the TS implementation
// (src/shared/sync.ts:syncEventIdInput). If this drifts, BatchUpsert's
// forgery guard rejects every legit event the desktop posts.
func TestEventIDInput_Format(t *testing.T) {
	got := EventIDInput("teamA", "userB", "node-1", "local-99")
	want := "teamA|userB|node-1|local-99"
	if got != want {
		t.Fatalf("EventIDInput = %q, want %q", got, want)
	}
}

// SHA-256 of "teamA|userB|node-1|local-99" pre-computed via:
//   echo -n "teamA|userB|node-1|local-99" | shasum -a 256
// Server recomputes this on every event-kind upload; mismatches reject.
func TestComputeEventID_StableHash(t *testing.T) {
	got := ComputeEventID("teamA", "userB", "node-1", "local-99")
	want := "7e7655b59454ce4fc9ae17da7c8cf3881cb51795d5bda220dac0c01b3f0b43ab"
	if got != want {
		t.Fatalf("ComputeEventID = %q, want %q", got, want)
	}
}

func TestComputeEventID_DifferentInputsDiffer(t *testing.T) {
	a := ComputeEventID("t", "u", "n", "1")
	b := ComputeEventID("t", "u", "n", "2")
	if a == b {
		t.Fatalf("collisions on local_event_id should be impossible: %q == %q", a, b)
	}
}
