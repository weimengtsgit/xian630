package runner

import (
	"strings"
	"testing"
)

// TestAuditDockerfile locks in the code_gen-side guard against generated
// Dockerfiles that COPY a package-lock.json the factory never generates. A
// wildcard source like `COPY package.json package-lock.json* ./` matches
// nothing in the build context and fails BuildKit's COPY step; the factory
// runs `npm install` (which creates the lockfile inside the image), so the
// Dockerfile must COPY only package.json. Catching this at code_gen (not at
// product_acceptance) keeps it inside the bounded-repair budget.
func TestAuditDockerfile(t *testing.T) {
	tests := []struct {
		name       string
		dockerfile string
		wantErr    bool
	}{
		{
			name: "wildcard lockfile COPY rejected",
			dockerfile: "FROM node:20-alpine AS builder\n" +
				"WORKDIR /app\n" +
				"COPY package.json package-lock.json* ./\n" +
				"RUN npm install\n" +
				"COPY . .\n" +
				"RUN npm run build\n",
			wantErr: true,
		},
		{
			name: "literal lockfile COPY rejected",
			dockerfile: "FROM node:20-alpine\n" +
				"WORKDIR /app\n" +
				"COPY package.json package-lock.json ./\n" +
				"RUN npm install\n",
			wantErr: true,
		},
		{
			name: "package.json only COPY accepted",
			dockerfile: "FROM node:20-alpine\n" +
				"WORKDIR /app\n" +
				"COPY package.json ./\n" +
				"RUN npm install\n" +
				"RUN npm run build\n",
			wantErr: false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			writeAppFile(t, dir, "Dockerfile", tc.dockerfile)

			err := AuditDockerfile(dir)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("AuditDockerfile: expected error, got nil")
				}
				if !strings.Contains(err.Error(), "package-lock.json") {
					t.Fatalf("AuditDockerfile error should name package-lock.json, got %q", err.Error())
				}
				if !strings.Contains(err.Error(), "COPY package.json ./") && !strings.Contains(err.Error(), "npm install") {
					t.Fatalf("AuditDockerfile error should point at the fix (COPY package.json ./ + npm install), got %q", err.Error())
				}
			} else if err != nil {
				t.Fatalf("AuditDockerfile: expected no error, got %v", err)
			}
		})
	}

	t.Run("missing Dockerfile is a no-op", func(t *testing.T) {
		dir := t.TempDir()
		if err := AuditDockerfile(dir); err != nil {
			t.Fatalf("AuditDockerfile on dir without Dockerfile should be a no-op, got %v", err)
		}
	})
}
