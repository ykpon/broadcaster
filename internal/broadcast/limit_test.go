package broadcast

import "testing"

func TestViewerLimitPreservesArbitraryPrecision(t *testing.T) {
	limit, err := ParseViewerLimit("000100000000000000000000000000000000000000000000000")
	if err != nil {
		t.Fatal(err)
	}
	if got := limit.String(); got != "100000000000000000000000000000000000000000000000" {
		t.Fatalf("normalized limit = %q", got)
	}
	if !limit.Allows(10_000) {
		t.Fatal("large limit rejected ordinary occupancy")
	}
}

func TestViewerLimitRejectsNonPositiveOrNonIntegralInput(t *testing.T) {
	for _, raw := range []string{"", "0", "-1", "+1", "1.5", " 10", "10 "} {
		if _, err := ParseViewerLimit(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
}
