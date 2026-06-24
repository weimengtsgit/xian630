package store

import (
	"context"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestCreateApplicationVersionKeepsParentBaseline(t *testing.T) {
	st := newTestStore(t)
	got, err := st.CreateApplicationVersion(context.Background(), model.ApplicationVersion{
		ID: "ver_2", ApplicationID: "app_1", ParentVersionID: "ver_1",
		JobID: "job_2", Status: model.ApplicationVersionQueued,
	})
	if err != nil || got.ParentVersionID != "ver_1" {
		t.Fatalf("version=%#v err=%v", got, err)
	}
}

func TestGetEffectiveApplicationVersion(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	// No versions yet: a miss is not an error.
	if got, err := st.GetEffectiveApplicationVersion(ctx, "app_1"); err != nil || got != nil {
		t.Fatalf("empty effective = %#v err=%v", got, err)
	}

	// A queued version is NOT effective.
	if _, err := st.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID: "ver_q", ApplicationID: "app_1", ParentVersionID: "",
		JobID: "job_q", Status: model.ApplicationVersionQueued,
	}); err != nil {
		t.Fatalf("create queued: %v", err)
	}
	if got, err := st.GetEffectiveApplicationVersion(ctx, "app_1"); err != nil || got != nil {
		t.Fatalf("queued effective = %#v err=%v", got, err)
	}

	// Promote ver_q to effective (backdate its promoted_at so it sorts before
	// a later effective sibling).
	promoted := time.Now().Add(-time.Hour)
	eff, err := st.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID: "ver_eff", ApplicationID: "app_1", ParentVersionID: "ver_q",
		JobID: "job_eff", Status: model.ApplicationVersionEffective, PromotedAt: &promoted,
	})
	if err != nil {
		t.Fatalf("create effective: %v", err)
	}
	got, err := st.GetEffectiveApplicationVersion(ctx, "app_1")
	if err != nil {
		t.Fatalf("effective err: %v", err)
	}
	if got == nil || got.ID != "ver_eff" {
		t.Fatalf("effective = %#v want ver_eff", got)
	}
	if eff.PromotedAt == nil {
		t.Fatalf("persisted effective lost PromotedAt")
	}
}

func TestListApplicationVersionsLineageOrder(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	base := time.Now()
	// Insert out of creation order to confirm ORDER BY created_at ASC holds.
	if _, err := st.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID: "ver_3", ApplicationID: "app_1", ParentVersionID: "ver_2",
		JobID: "job_3", Status: model.ApplicationVersionEffective, CreatedAt: base.Add(2 * time.Second),
	}); err != nil {
		t.Fatalf("create v3: %v", err)
	}
	if _, err := st.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID: "ver_1", ApplicationID: "app_1", ParentVersionID: "",
		JobID: "job_1", Status: model.ApplicationVersionSuperseded, CreatedAt: base,
	}); err != nil {
		t.Fatalf("create v1: %v", err)
	}
	if _, err := st.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID: "ver_2", ApplicationID: "app_1", ParentVersionID: "ver_1",
		JobID: "job_2", Status: model.ApplicationVersionSuperseded, CreatedAt: base.Add(1 * time.Second),
	}); err != nil {
		t.Fatalf("create v2: %v", err)
	}
	// A version for a different app must not leak in.
	if _, err := st.CreateApplicationVersion(ctx, model.ApplicationVersion{
		ID: "ver_other", ApplicationID: "app_2", ParentVersionID: "",
		JobID: "job_other", Status: model.ApplicationVersionQueued, CreatedAt: base,
	}); err != nil {
		t.Fatalf("create other: %v", err)
	}

	got, err := st.ListApplicationVersions(ctx, "app_1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len = %d want 3: %#v", len(got), got)
	}
	wantOrder := []string{"ver_1", "ver_2", "ver_3"}
	for i, w := range wantOrder {
		if got[i].ID != w {
			t.Fatalf("order[%d] = %s want %s: %#v", i, got[i].ID, w, got)
		}
	}
	// Parent lineage is preserved across the round-trip.
	if got[1].ParentVersionID != "ver_1" || got[2].ParentVersionID != "ver_2" {
		t.Fatalf("parent lineage lost: %#v", got)
	}
}
