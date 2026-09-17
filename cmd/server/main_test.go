package main

import "testing"

func TestIsLocalAppURL(t *testing.T) {
	tests := []struct {
		url  string
		want bool
	}{
		{"http://localhost", true},
		{"http://localhost:8080", true},
		{"http://127.0.0.1:8080", true},
		{"http://[::1]:8080", true},
		{"https://stream.example.com", false},
		{"not-a-url", false},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			if got := isLocalAppURL(tt.url); got != tt.want {
				t.Fatalf("isLocalAppURL(%q) = %v, want %v", tt.url, got, tt.want)
			}
		})
	}
}
