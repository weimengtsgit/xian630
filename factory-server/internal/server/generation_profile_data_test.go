package server

import (
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/clarification"
)

// containsSkill reports whether the data-skill list contains key. Order is not
// part of the contract; only presence matters.
func containsSkill(skills []string, key string) bool {
	for _, s := range skills {
		if s == key {
			return true
		}
	}
	return false
}

// TestDeriveDataSkillsLiveTide proves the real-data-default derivation: a
// live_api requirement whose scenario mentions the tide domain MUST surface the
// tide-data-skill, even though the model never put one in the profile.
func TestDeriveDataSkillsLiveTide(t *testing.T) {
	req := clarification.Requirement{
		DataPolicy:   "live_api",
		AppName:      "航母母港潮汐窗口计算器",
		CoreScenario: "监控诺福克等港口潮汐高度与出港窗口",
		MainEntities: []string{"港口", "潮汐"},
	}
	if got := deriveDataSkills(req); !containsSkill(got, "tide-data-skill") {
		t.Fatalf("deriveDataSkills = %v, want tide-data-skill for live_api tide scenario", got)
	}
}

func TestDeriveDataSkillsLiveWind(t *testing.T) {
	req := clarification.Requirement{
		DataPolicy:   "live_api",
		CoreScenario: "航母甲板风速与起飞回收风向评估",
		MainEntities: []string{"甲板风"},
	}
	if got := deriveDataSkills(req); !containsSkill(got, "deck-wind-data-skill") {
		t.Fatalf("deriveDataSkills = %v, want deck-wind-data-skill for live_api wind scenario", got)
	}
}

func TestDeriveDataSkillsLiveAIS(t *testing.T) {
	req := clarification.Requirement{
		DataPolicy:   "live_api",
		CoreScenario: "近海商船密度与50海里网格船舶流量分析",
		MainEntities: []string{"商船"},
	}
	if got := deriveDataSkills(req); !containsSkill(got, "ais-density-data-skill") {
		t.Fatalf("deriveDataSkills = %v, want ais-density-data-skill for live_api AIS scenario", got)
	}
}

func TestDeriveDataSkillsLiveCarrier(t *testing.T) {
	req := clarification.Requirement{
		DataPolicy:   "live_api",
		CoreScenario: "航母舰载机 ADS-B 归属推断与离舰判定",
		MainEntities: []string{"舰载机"},
	}
	if got := deriveDataSkills(req); !containsSkill(got, "carrier-affiliation-data-skill") {
		t.Fatalf("deriveDataSkills = %v, want carrier-affiliation-data-skill for live_api carrier scenario", got)
	}
}

// TestDeriveDataSkillsLiveMilitaryAISRoutesToCarrier proves the merchant/military
// AIS split: a requirement about MILITARY vessel AIS (carriers / warships / navy —
// 航母/舰船/军舰) MUST route to carrier-affiliation-data-skill, whose ontology
// RawAISData adapter is the real source for military vessel tracks. It must NOT
// be served only by ais-density-data-skill, whose MarineCadastre source is
// merchant-density and carries no military vessels.
func TestDeriveDataSkillsLiveMilitaryAISRoutesToCarrier(t *testing.T) {
	req := clarification.Requirement{
		DataPolicy:   "live_api",
		AppName:      "航母编队舰船AIS航迹监控",
		CoreScenario: "追踪航母打击群内军舰与舰艇的AIS航迹",
		MainEntities: []string{"航母", "舰船", "军舰"},
	}
	if got := deriveDataSkills(req); !containsSkill(got, "carrier-affiliation-data-skill") {
		t.Fatalf("deriveDataSkills = %v, want carrier-affiliation-data-skill for military-vessel AIS (ontology RawAISData), not the merchant-density skill", got)
	} else if containsSkill(got, "ais-density-data-skill") {
		t.Fatalf("deriveDataSkills = %v, must not include ais-density-data-skill for military-vessel AIS", got)
	}
}

// TestDeriveDataSkillsMockDataNeverAdds proves the mock-policy rule: even when a
// domain matches, mock_data MUST NOT auto-add a data skill (mock is explicit).
func TestDeriveDataSkillsMockDataNeverAdds(t *testing.T) {
	req := clarification.Requirement{
		DataPolicy:   "mock_data",
		CoreScenario: "监控港口潮汐高度", // tide domain hits
		MainEntities: []string{"潮汐"},
	}
	if got := deriveDataSkills(req); len(got) != 0 {
		t.Fatalf("deriveDataSkills(mock_data) = %v, want no skills auto-added for mock_data", got)
	}
}

// TestDeriveDataSkillsNoDomain proves a live_api requirement with no data domain
// yields no data skill (do not pollute non-data apps).
func TestDeriveDataSkillsNoDomain(t *testing.T) {
	req := clarification.Requirement{
		DataPolicy:   "live_api",
		AppName:      "通用态势复盘",
		CoreScenario: "近一个月编队航迹与事件复盘",
		MainEntities: []string{"编队", "事件"},
	}
	if got := deriveDataSkills(req); len(got) != 0 {
		t.Fatalf("deriveDataSkills(no domain) = %v, want no skills", got)
	}
}

// TestDeriveDataSkillsMultipleDomains proves several domains can be derived at
// once when the scenario spans them.
func TestDeriveDataSkillsMultipleDomains(t *testing.T) {
	req := clarification.Requirement{
		DataPolicy:   "live_api",
		CoreScenario: "同时监控港口潮汐与甲板风速",
		MainEntities: []string{"潮汐", "甲板风"},
	}
	got := deriveDataSkills(req)
	if !containsSkill(got, "tide-data-skill") || !containsSkill(got, "deck-wind-data-skill") {
		t.Fatalf("deriveDataSkills = %v, want both tide and deck-wind skills", got)
	}
}

// TestRecomputeGenerationProfileDerivesAndPreservesBase proves the full server
// entrypoint: base/domain/pattern come from appType, AND a matched data domain
// is added into the data group for a live_api requirement.
func TestRecomputeGenerationProfileDerivesAndPreservesBase(t *testing.T) {
	req := clarification.Requirement{
		AppType:           "situation_replay",
		DataPolicy:        "live_api",
		CoreScenario:      "港口潮汐窗口监控",
		MainEntities:      []string{"潮汐"},
		GenerationProfile: map[string][]string{},
	}
	profile := recomputeGenerationProfile(req)
	if got := strings.Join(profile["base"], ","); got != "software-factory-app" {
		t.Fatalf("base = %q, want software-factory-app", got)
	}
	if len(profile["pattern"]) == 0 || profile["pattern"][0] != "map-timeline-replay" {
		t.Fatalf("pattern = %v, want map-timeline-replay", profile["pattern"])
	}
	if !containsSkill(profile["data"], "tide-data-skill") {
		t.Fatalf("data = %v, want tide-data-skill derived", profile["data"])
	}
}

// TestRecomputeGenerationProfileMockDataDoesNotAutoAdd proves mock_data keeps the
// base/domain/pattern triplet but adds no data skill, even when a domain matches.
func TestRecomputeGenerationProfileMockDataDoesNotAutoAdd(t *testing.T) {
	req := clarification.Requirement{
		AppType:           "command_dashboard",
		DataPolicy:        "mock_data",
		CoreScenario:      "港口潮汐窗口监控",
		MainEntities:      []string{"潮汐"},
		GenerationProfile: map[string][]string{},
	}
	profile := recomputeGenerationProfile(req)
	if len(profile["data"]) != 0 {
		t.Fatalf("data = %v, want no auto-added data skill for mock_data", profile["data"])
	}
	if len(profile["base"]) == 0 {
		t.Fatalf("base missing; profile = %#v", profile)
	}
}

// TestRecomputeGenerationProfilePreservesExistingDataGroup proves the confirm-path
// contract: an already-selected data skill (e.g. from a prior round / persisted
// requirement) is preserved while a newly-matched domain is added — data skills
// are never silently dropped on recompute.
func TestRecomputeGenerationProfilePreservesExistingDataGroup(t *testing.T) {
	// existing (persisted) profile already carries deck-wind; the incoming
	// requirement now also matches tide. Both must survive.
	existing := map[string][]string{
		"base": {"software-factory-app"},
		"data": {"deck-wind-data-skill"},
	}
	incoming := clarification.Requirement{
		AppType:           "command_dashboard",
		DataPolicy:        "live_api",
		CoreScenario:      "同时监控潮汐与海面风",
		MainEntities:      []string{"潮汐"},
		GenerationProfile: map[string][]string{},
	}
	profile := recomputeGenerationProfile(incoming, existing)
	if !containsSkill(profile["data"], "deck-wind-data-skill") {
		t.Fatalf("data = %v, want preserved deck-wind-data-skill", profile["data"])
	}
	if !containsSkill(profile["data"], "tide-data-skill") {
		t.Fatalf("data = %v, want derived tide-data-skill", profile["data"])
	}
}

// TestRecomputeGenerationProfileLivePreservesAndDerivesDedup proves live_api keeps
// an inherited data skill AND derives a newly-matched one, with no duplicates.
func TestRecomputeGenerationProfileLivePreservesAndDerivesDedup(t *testing.T) {
	existing := map[string][]string{
		"base": {"software-factory-app"},
		"data": {"deck-wind-data-skill"},
	}
	req := clarification.Requirement{
		AppType:      "command_dashboard",
		DataPolicy:   "live_api",
		CoreScenario: "港口潮汐窗口监控", // tide domain only
	}
	profile := recomputeGenerationProfile(req, existing)
	data := profile["data"]
	if !containsSkill(data, "deck-wind-data-skill") {
		t.Fatalf("data = %v, want preserved deck-wind-data-skill", data)
	}
	if !containsSkill(data, "tide-data-skill") {
		t.Fatalf("data = %v, want derived tide-data-skill", data)
	}
	dups := 0
	for _, s := range data {
		if s == "tide-data-skill" {
			dups++
		}
	}
	if dups > 1 {
		t.Fatalf("data = %v, tide-data-skill duplicated", data)
	}
}

// TestRecomputeGenerationProfileMockDataDropsInheritedData is the regression test
// for the mock_data bug: switching a requirement to mock_data must NOT carry over
// a real-data skill that a prior live_api state derived/persisted, even though the
// scenario text still matches the domain. mock_data must never load a real-data
// capability. base/domain/pattern must remain intact.
func TestRecomputeGenerationProfileMockDataDropsInheritedData(t *testing.T) {
	existing := map[string][]string{
		"base": {"software-factory-app"},
		"data": {"tide-data-skill"},
	}
	req := clarification.Requirement{
		AppType:      "command_dashboard",
		DataPolicy:   "mock_data",
		CoreScenario: "港口潮汐窗口监控", // tide domain still matches text
	}
	profile := recomputeGenerationProfile(req, existing)
	if data := profile["data"]; len(data) != 0 {
		t.Fatalf("data = %v, want empty (mock_data must not keep inherited data skills)", data)
	}
	if len(profile["base"]) == 0 || len(profile["domain"]) == 0 || len(profile["pattern"]) == 0 {
		t.Fatalf("base/domain/pattern must remain for mock_data: %#v", profile)
	}
}

// TestRecomputeGenerationProfileEmptyPolicyDropsInheritedData proves an empty /
// unknown dataPolicy does not load an inherited real-data capability (safest
// default — avoid surfacing real-data skills in an undecided state).
func TestRecomputeGenerationProfileEmptyPolicyDropsInheritedData(t *testing.T) {
	existing := map[string][]string{
		"base": {"software-factory-app"},
		"data": {"tide-data-skill"},
	}
	req := clarification.Requirement{
		AppType:      "command_dashboard",
		DataPolicy:   "", // undecided
		CoreScenario: "港口潮汐",
	}
	profile := recomputeGenerationProfile(req, existing)
	if data := profile["data"]; len(data) != 0 {
		t.Fatalf("data = %v, want empty for empty policy (no inherited real-data capability)", data)
	}
}
