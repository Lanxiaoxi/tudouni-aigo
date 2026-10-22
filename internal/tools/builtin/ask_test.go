package builtin

import (
	"context"
	"strings"
	"testing"
)

// recordingQuestioner answers with the question's header, so a test can tell which
// question produced which answer, and records the questions in the order they were
// actually asked.
func recordingQuestioner(seen *[]AskArgs) Questioner {
	return func(questions []AskArgs) []Answer {
		*seen = append(*seen, questions...)
		answers := make([]Answer, len(questions))
		for index, args := range questions {
			answers[index] = Answer{Text: "回答：" + args.Header, Status: Answered, HumanWaitMs: 10}
		}
		return answers
	}
}

// TestAskUserAsksEveryQuestionInOrder: one call may carry several questions, and
// the channel underneath speaks one question per round trip — so the tool has to
// hand them over one at a time, in order, and fold the answers back together.
func TestAskUserAsksEveryQuestionInOrder(t *testing.T) {
	var seen []AskArgs
	tool := NewAskUser(recordingQuestioner(&seen))

	result, err := tool.Execute(context.Background(), map[string]any{
		"questions": []any{
			map[string]any{"question": "先问这个？", "header": "一", "options": []any{"甲", "乙"}},
			map[string]any{"question": "再问这个？", "header": "二", "multi_select": true},
		},
	})
	if err != nil {
		t.Fatalf("the tool refused a well-formed call: %v", err)
	}

	if len(seen) != 2 {
		t.Fatalf("the channel saw %d questions, want 2", len(seen))
	}
	if seen[0].Question != "先问这个？" || seen[0].Header != "一" {
		t.Errorf("the first question went out wrong: %+v", seen[0])
	}
	if len(seen[0].Options) != 2 {
		t.Errorf("the first question lost its options: %+v", seen[0])
	}
	if seen[1].Question != "再问这个？" || !seen[1].MultiSelect {
		t.Errorf("the second question went out wrong: %+v", seen[1])
	}

	// Both answers, each attached to its own question.
	for _, want := range []string{"先问这个？", "回答：一", "再问这个？", "回答：二"} {
		if !strings.Contains(result.Text, want) {
			t.Errorf("the result is missing %q:\n%s", want, result.Text)
		}
	}

	if got := result.Audit["question_count"]; got != 2 {
		t.Errorf("question_count = %v, want 2", got)
	}
	if got := result.Audit["human_wait_ms"]; got != 20 {
		t.Errorf("human_wait_ms = %v, want the two waits summed (20)", got)
	}
	statuses, _ := result.Audit["question_statuses"].([]string)
	if len(statuses) != 2 || statuses[0] != Answered || statuses[1] != Answered {
		t.Errorf("question_statuses = %v, want two answered", result.Audit["question_statuses"])
	}
}

// TestAskUserSingleQuestionKeepsTheOldWording: the common case is one question, and
// its result must be word-for-word what it was before the tool learned to carry
// several — nothing downstream should have to notice.
func TestAskUserSingleQuestionKeepsTheOldWording(t *testing.T) {
	tool := NewAskUser(func(questions []AskArgs) []Answer {
		answers := make([]Answer, len(questions))
		for index := range questions {
			answers[index] = Answer{Text: "第二个", Status: Answered}
		}
		return answers
	})

	result, err := tool.Execute(context.Background(), map[string]any{
		"questions": []any{map[string]any{"question": "选哪个？"}},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.Text != "用户回答：第二个" {
		t.Errorf("text = %q, want the unchanged single-question wording", result.Text)
	}
}

// TestAskUserEmptyQuestionsAsksNobody: an empty list is not a question, so the
// channel must not be touched — and the result must not read as "the user had no
// opinion".
func TestAskUserEmptyQuestionsAsksNobody(t *testing.T) {
	asked := 0
	tool := NewAskUser(func(questions []AskArgs) []Answer {
		asked += len(questions)
		return make([]Answer, len(questions))
	})

	result, err := tool.Execute(context.Background(), map[string]any{"questions": []any{}})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if asked != 0 {
		t.Errorf("the channel was asked %d times for an empty list", asked)
	}
	if !strings.Contains(result.Text, "没有要问的问题") {
		t.Errorf("the empty result does not say nothing was asked:\n%s", result.Text)
	}
}

// TestAskUserSchemaCarriesQuestions: the model has to see `questions`, and each
// entry has to be an object with its own `question` — otherwise the model would
// send the old singular shape and get a rejection it cannot interpret.
func TestAskUserSchemaCarriesQuestions(t *testing.T) {
	tool := NewAskUser(nil)
	if _, err := tool.Execute(context.Background(), map[string]any{
		"question": "老写法？",
	}); err == nil {
		t.Error("the old singular `question` shape was accepted; the schema should require `questions`")
	}

	if _, err := tool.Execute(context.Background(), map[string]any{
		"questions": []any{map[string]any{"header": "缺了正文"}},
	}); err == nil {
		t.Error("an entry without `question` was accepted")
	}

	if _, err := tool.Execute(context.Background(), map[string]any{
		"questions": []any{map[string]any{"question": "没问题？"}},
	}); err != nil {
		t.Errorf("a well-formed call was rejected: %v", err)
	}
}
