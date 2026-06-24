package catalog

import "testing"

func TestToggleUnmarshalBoolSetsEnabledAndVisibility(t *testing.T) {
	var tg Toggle
	if err := tg.UnmarshalJSON([]byte(`true`)); err != nil {
		t.Fatalf("UnmarshalJSON: %v", err)
	}
	if tg.Enabled == nil || !*tg.Enabled {
		t.Fatalf("Enabled = %#v, want true", tg.Enabled)
	}
	if tg.ShowInAppList == nil || !*tg.ShowInAppList {
		t.Fatalf("ShowInAppList = %#v, want true", tg.ShowInAppList)
	}
}
