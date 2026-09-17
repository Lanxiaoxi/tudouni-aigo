package mcp

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// One server connection: handshake, tool listing, tool calls.
//
// Everything above the transport lives here, so a server reached over a pipe and
// one reached over HTTP go through the same code and fail the same way.

// ToolSpec is one tool a server offers.
type ToolSpec struct {
	Name        string
	Description string
	Schema      map[string]any
}

// Connection is one live server.
type Connection struct {
	ServerName string
	Channel    Channel
	Timeout    time.Duration

	capabilities map[string]any
	instructions string
}

// NewConnection builds a connection over a channel.
func NewConnection(serverName string, channel Channel, timeoutSeconds float64) *Connection {
	if timeoutSeconds < MinTimeoutSeconds || timeoutSeconds > MaxTimeoutSeconds {
		timeoutSeconds = DefaultTimeoutSeconds
	}
	return &Connection{
		ServerName: serverName,
		Channel:    channel,
		Timeout:    time.Duration(timeoutSeconds * float64(time.Second)),
	}
}

// Open performs the handshake.
//
// The initialised notification goes out before anything else is asked for: the
// spec requires it, and a server that never receives it is entitled to ignore every
// subsequent request — which would look like an unresponsive server rather than a
// missing message.
func (c *Connection) Open() error {
	result, err := c.Channel.Request("initialize", map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo": map[string]any{
			"name":    "tudouni",
			"version": "0.1",
		},
	}, c.Timeout)
	if err != nil {
		return err
	}

	c.capabilities, _ = result["capabilities"].(map[string]any)
	c.instructions, _ = result["instructions"].(string)

	// The notification's failure is not fatal on its own, but a server that cannot
	// receive it cannot be talked to either, so the error is returned.
	return c.Channel.Notify("notifications/initialized", map[string]any{})
}

// Instructions is the guidance the server offered at handshake time.
func (c *Connection) Instructions() string { return c.instructions }

// OffersTools reports whether the server declared a tools capability.
//
// A server that declares none is **connected with zero tools**, not failed: the two
// are different facts, and reporting the second when the first is true sends
// somebody hunting for a connection problem that does not exist.
func (c *Connection) OffersTools() bool {
	if c.capabilities == nil {
		return false
	}
	_, present := c.capabilities["tools"]
	return present
}

// ListTools walks the paginated listing.
//
// Pagination has an upper bound: a server that keeps handing out cursors would
// otherwise hold the start-up path forever, and "it hung" is a much worse thing to
// report than "it kept paging".
func (c *Connection) ListTools() ([]ToolSpec, error) {
	var tools []ToolSpec
	var cursor string

	for page := 0; page < MaxListPages; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		result, err := c.Channel.Request("tools/list", params, c.Timeout)
		if err != nil {
			return nil, err
		}

		entries, _ := result["tools"].([]any)
		for _, entry := range entries {
			object, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			name, _ := object["name"].(string)
			if name == "" {
				// A tool with no name cannot be called and cannot be shown, so it
				// is dropped rather than given an invented one.
				continue
			}
			spec := ToolSpec{
				Name:        name,
				Description: stringField(object, "description"),
			}
			if schema, ok := object["inputSchema"].(map[string]any); ok {
				spec.Schema = schema
			}
			tools = append(tools, spec)
		}

		next, _ := result["nextCursor"].(string)
		if next == "" {
			return tools, nil
		}
		cursor = next
	}

	return nil, McpError{Message: fmt.Sprintf(
		"tools/list went through %d pages without ending, giving up", MaxListPages)}
}

// CallTool invokes one tool and returns its rendered text.
func (c *Connection) CallTool(name string, arguments map[string]any) (string, error) {
	if arguments == nil {
		arguments = map[string]any{}
	}
	result, err := c.Channel.Request("tools/call", map[string]any{
		"name":      name,
		"arguments": arguments,
	}, c.Timeout)
	if err != nil {
		return "", err
	}

	text := renderContent(result["content"])

	// An error flag with content is the server's normal way of reporting a failed
	// call, and the text is the explanation. Returning it as a result rather than
	// an error keeps that explanation in front of the model — which is the whole
	// point of it being a sentence.
	if isError, _ := result["isError"].(bool); isError {
		if text == "" {
			text = fmt.Sprintf("%s failed (the server gave no explanation)", name)
		}
		return text, nil
	}
	if text == "" {
		// Not an empty string: the model cannot tell "the tool returned nothing"
		// from "the tool broke", the same rule as shell's "(no output)".
		return fmt.Sprintf("（%s 执行了，但没有返回文本内容。）", name), nil
	}
	return text, nil
}

// Close shuts the connection down.
func (c *Connection) Close() error { return c.Channel.Close() }

// Where is the redacted location of this server.
func (c *Connection) Where() string { return c.Channel.Where() }

// renderContent turns the content blocks of a tools/call result into text.
//
// The block types are the spec's, and the ones that are not text become a
// placeholder naming what was there. Dropping them silently would make a result
// that carried an image look like a result that carried nothing.
func renderContent(raw any) string {
	blocks, ok := raw.([]any)
	if !ok {
		if text, ok := raw.(string); ok {
			return text
		}
		return ""
	}

	var parts []string
	for _, entry := range blocks {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		switch stringField(object, "type") {
		case "text":
			if text := stringField(object, "text"); text != "" {
				parts = append(parts, text)
			}
		case "image":
			parts = append(parts, fmt.Sprintf("（一张 %s 图片，共 %d 字节的 base64 数据；需要的话请让用户打开它）",
				stringField(object, "mimeType"), len(stringField(object, "data"))))
		case "audio":
			parts = append(parts, fmt.Sprintf("（一段 %s 音频，共 %d 字节的 base64 数据）",
				stringField(object, "mimeType"), len(stringField(object, "data"))))
		case "resource":
			uri := ""
			if resource, ok := object["resource"].(map[string]any); ok {
				uri = stringField(resource, "uri")
			}
			parts = append(parts, fmt.Sprintf("（一份资源：%s）", uri))
		default:
			raw, _ := json.Marshal(object)
			parts = append(parts, string(raw))
		}
	}
	return strings.Join(parts, "\n")
}

func stringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}
