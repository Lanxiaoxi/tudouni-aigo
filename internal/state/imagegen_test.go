package state

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The `image_generation` section.
//
// The section is read out of the **top level** of the configuration, not out
// of `providers[].models[]`, and the reason is the whole of the design: that
// list is a list of models that may be chosen as the *conversation* model, and
// a picture model in it would show up in `/model`, be selectable, and then
// fail every chat request.

// writeImageConfig writes a configuration file and returns its path.
func writeImageConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing the configuration: %v", err)
	}
	return path
}

// A configuration with one chat route and an image section that inherits from
// it.
const imageConfigWithProvider = `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o", "context_window": 128000}]
    }
  },
  "image_generation": {
    "provider": "openai",
    "model": "gpt-image-1"
  }
}`

// TestTheImageRouteInheritsTheKeyAndTheEndpoint checks the inheritance.
//
// This is the reason the section exists: one key is written once. A section
// that had to repeat the key would have two copies of it, and the second one
// would be the stale one.
func TestTheImageRouteInheritsTheKeyAndTheEndpoint(t *testing.T) {
	path := writeImageConfig(t, imageConfigWithProvider)

	catalog, err := Load(path)
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	route := catalog.Image
	if !route.Configured() {
		t.Fatal("the image route is not configured")
	}
	if route.Model != "gpt-image-1" {
		t.Errorf("the model is %q, want gpt-image-1", route.Model)
	}
	if route.BaseURL != "https://api.openai.com/v1" {
		t.Errorf("the base url is %q, want the inherited one", route.BaseURL)
	}
	if route.APIKey != "sk-chat" {
		t.Errorf("the key is %q, want the inherited one", route.APIKey)
	}
	if route.Provider != "openai" {
		t.Errorf("the provider is %q, want openai", route.Provider)
	}
}

// TestTheImageRouteIsNotInTheModelList checks the separation.
//
// A picture model in `providers[].models[]` would show up in `/model`, be
// selectable, and then fail every chat request.
func TestTheImageRouteIsNotInTheModelList(t *testing.T) {
	path := writeImageConfig(t, imageConfigWithProvider)

	catalog, err := Load(path)
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	if _, found := catalog.Find("gpt-image-1", ""); found {
		t.Error("the image model is findable as a conversation model")
	}
	if _, found := catalog.Find("gpt-image-1", "openai"); found {
		t.Error("the image model is findable on the route it inherited from")
	}
}

// TestAnAbsentSectionIsNotAProblem checks that "not configured" is normal.
//
// The capability was never promised, so a machine without it is not broken.
func TestAnAbsentSectionIsNotAProblem(t *testing.T) {
	path := writeImageConfig(t, `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o"}]
    }
  }
}`)

	catalog, err := Load(path)
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	if catalog.Image.Configured() {
		t.Error("an absent section produced a configured route")
	}
	if len(catalog.Problems) != 0 {
		t.Errorf("the catalogue has problems: %v", catalog.Problems)
	}
}

// TestTheSectionOverridesTheInheritedValues checks the override.
//
// The section's own value is the more specific one, so it wins.
func TestTheSectionOverridesTheInheritedValues(t *testing.T) {
	path := writeImageConfig(t, `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o"}]
    }
  },
  "image_generation": {
    "provider": "openai",
    "model": "gpt-image-1",
    "base_url": "https://images.example/v1",
    "api_key": "sk-images"
  }
}`)

	catalog, err := Load(path)
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	if catalog.Image.BaseURL != "https://images.example/v1" {
		t.Errorf("the base url is %q, want the override", catalog.Image.BaseURL)
	}
	if catalog.Image.APIKey != "sk-images" {
		t.Errorf("the key is %q, want the override", catalog.Image.APIKey)
	}
}

// TestAProviderThatNamesNothingListsTheRoutesThatDo checks the error.
//
// "no such route" without the list sends the reader hunting through the file
// for a name that is not there.
func TestAProviderThatNamesNothingListsTheRoutesThatDo(t *testing.T) {
	path := writeImageConfig(t, `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o"}]
    }
  },
  "image_generation": {
    "provider": "openai-does-not-exist",
    "model": "gpt-image-1"
  }
}`)

	_, err := Load(path)
	if err == nil {
		t.Fatal("a provider that names nothing was accepted")
	}
	if !strings.Contains(err.Error(), "openai-does-not-exist") {
		t.Errorf("the message does not name the bad provider: %v", err)
	}
	if !strings.Contains(err.Error(), "openai") {
		t.Errorf("the message does not list the routes that do exist: %v", err)
	}
}

// TestAMissingModelIsRefused checks the required key.
//
// The model is never inherited: the chat route's model is a different model,
// and sending a picture request to a chat model produces a 404 or — worse —
// a chat completion where a picture was expected.
func TestAMissingModelIsRefused(t *testing.T) {
	path := writeImageConfig(t, `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o"}]
    }
  },
  "image_generation": {
    "provider": "openai"
  }
}`)

	_, err := Load(path)
	if err == nil {
		t.Fatal("a section with no model was accepted")
	}
	if !strings.Contains(err.Error(), "model") {
		t.Errorf("the message does not name the missing key: %v", err)
	}
}

// TestAnUnknownStyleIsRefused checks that a typo is not the default.
//
// Silently treating a typo as the default is exactly the failure the
// configuration reader refuses everywhere else.
func TestAnUnknownStyleIsRefused(t *testing.T) {
	path := writeImageConfig(t, `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o"}]
    }
  },
  "image_generation": {
    "provider": "openai",
    "model": "gpt-image-1",
    "api_style": "openai-image"
  }
}`)

	_, err := Load(path)
	if err == nil {
		t.Fatal("an unknown style was accepted")
	}
	if !strings.Contains(err.Error(), "openai-images") {
		t.Errorf("the message does not list the styles that exist: %v", err)
	}
}

// TestAnUnknownKeyIsRefused checks that a misspelled key does not do nothing
// silently.
func TestAnUnknownKeyIsRefused(t *testing.T) {
	path := writeImageConfig(t, `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o"}]
    }
  },
  "image_generation": {
    "provider": "openai",
    "model": "gpt-image-1",
    "api_kie": "sk-typo"
  }
}`)

	_, err := Load(path)
	if err == nil {
		t.Fatal("an unknown key was accepted")
	}
	if !strings.Contains(err.Error(), "api_kie") {
		t.Errorf("the message does not name the offending key: %v", err)
	}
}

// TestTheSectionMayCarryEverythingItself checks the no-inheritance form.
//
// A person who wants a separate endpoint for pictures writes it all out, and
// the section does not need a `provider` for that.
func TestTheSectionMayCarryEverythingItself(t *testing.T) {
	path := writeImageConfig(t, `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o"}]
    }
  },
  "image_generation": {
    "base_url": "https://images.example/v1",
    "api_key": "sk-images",
    "model": "gpt-image-1"
  }
}`)

	catalog, err := Load(path)
	if err != nil {
		t.Fatalf("loading: %v", err)
	}
	if catalog.Image.BaseURL != "https://images.example/v1" {
		t.Errorf("the base url is %q, want the one written down", catalog.Image.BaseURL)
	}
	if catalog.Image.APIKey != "sk-images" {
		t.Errorf("the key is %q, want the one written down", catalog.Image.APIKey)
	}
}

// TestASectionWithNoBaseURLAndNoProviderIsRefused checks the last gap.
//
// Without either, there is nowhere for the request to go.
func TestASectionWithNoBaseURLAndNoProviderIsRefused(t *testing.T) {
	path := writeImageConfig(t, `{
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-chat",
      "models": [{"id": "gpt-4o"}]
    }
  },
  "image_generation": {
    "model": "gpt-image-1"
  }
}`)

	_, err := Load(path)
	if err == nil {
		t.Fatal("a route with nowhere to go was accepted")
	}
}
