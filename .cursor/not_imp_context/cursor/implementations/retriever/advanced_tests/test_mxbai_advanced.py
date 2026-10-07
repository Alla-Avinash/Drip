"""
Advanced tests for mxbai-embed-xsmall-v1.
Hard cases: near-duplicate labels, generic notes, 20 labels, distractors, short/ambiguous notes.
Run: pip install sentence-transformers && python retriever/test_mxbai_advanced.py
"""
import time
from typing import Optional
from sentence_transformers import SentenceTransformer, util

from test_data_advanced import (
    NOTE_DECORATORS,
    LABELS_NEAR_DUPLICATE,
    NOTE_GENERIC,
    LABELS_GENERIC,
    NOTE_DATABASE_INDEXES,
    LABELS_20,
    NOTE_PYTHON_DECORATORS_SHORT,
    LABELS_WRONG_SIMILAR,
    NOTE_SHORT,
    LABELS_SHORT_NOTE,
    NOTE_AMBIGUOUS,
    LABELS_AMBIGUOUS,
)


def run_retrieval(model, note: str, labels: list[str]) -> list[tuple[str, float]]:
    note_emb = model.encode(note)
    label_embs = model.encode(labels)
    similarities = util.cos_sim(note_emb, label_embs)[0]
    scores = [(labels[i], float(similarities[i])) for i in range(len(labels))]
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores


def print_scores(scores: list[tuple[str, float]], title: str) -> None:
    print(f"\n--- {title} ---")
    for i, (label, score) in enumerate(scores, 1):
        print(f"  {i}. {label}: {score:.4f}")
    if len(scores) >= 2:
        gap_1_2 = scores[0][1] - scores[1][1]
        print(f"  Gap (1st - 2nd): {gap_1_2:.4f}")
    if len(scores) >= 3:
        gap_2_3 = scores[1][1] - scores[2][1]
        print(f"  Gap (2nd - 3rd): {gap_2_3:.4f}")


def rank_of_label(scores: list[tuple[str, float]], label: str) -> Optional[int]:
    for i, (l, _) in enumerate(scores, 1):
        if l == label:
            return i
    return None


def score_of_label(scores: list[tuple[str, float]], label: str) -> Optional[float]:
    for l, s in scores:
        if l == label:
            return s
    return None


def main():
    print("Loading mixedbread-ai/mxbai-embed-xsmall-v1...")
    model = SentenceTransformer("mixedbread-ai/mxbai-embed-xsmall-v1")
    print("Model loaded.\n")

    total_time = 0.0

    # -----------------------------------------------------------------------
    # Test 1: Near-duplicate labels
    # -----------------------------------------------------------------------
    t0 = time.perf_counter()
    scores_1 = run_retrieval(model, NOTE_DECORATORS, LABELS_NEAR_DUPLICATE)
    elapsed_1 = time.perf_counter() - t0
    total_time += elapsed_1
    print_scores(scores_1, "Test 1: Near-duplicate labels (decorator note)")
    r = rank_of_label(scores_1, "Python Decorators")
    s = score_of_label(scores_1, "Python Decorators")
    if r is not None and s is not None:
        print(f"  Expected best 'Python Decorators' rank: {r}, score: {s:.4f}")
    print(f"  Time: {elapsed_1:.4f}s")

    # -----------------------------------------------------------------------
    # Test 2: Generic note (could fit many labels)
    # -----------------------------------------------------------------------
    t0 = time.perf_counter()
    scores_2 = run_retrieval(model, NOTE_GENERIC, LABELS_GENERIC)
    elapsed_2 = time.perf_counter() - t0
    total_time += elapsed_2
    print_scores(scores_2, "Test 2: Generic note (fits many labels)")
    print(f"  Time: {elapsed_2:.4f}s")

    # -----------------------------------------------------------------------
    # Test 3: 20 labels (max DRIP set)
    # -----------------------------------------------------------------------
    t0 = time.perf_counter()
    scores_3 = run_retrieval(model, NOTE_DATABASE_INDEXES, LABELS_20)
    elapsed_3 = time.perf_counter() - t0
    total_time += elapsed_3
    print_scores(scores_3, "Test 3: 20 labels – correct: 'Database Indexes'")
    r = rank_of_label(scores_3, "Database Indexes")
    s = score_of_label(scores_3, "Database Indexes")
    if r is not None and s is not None:
        print(f"  'Database Indexes' rank: {r}, score: {s:.4f}")
    print(f"  Time: {elapsed_3:.4f}s")

    # -----------------------------------------------------------------------
    # Test 4: Wrong-but-similar (JavaScript/TypeScript distractors)
    # -----------------------------------------------------------------------
    t0 = time.perf_counter()
    scores_4 = run_retrieval(model, NOTE_PYTHON_DECORATORS_SHORT, LABELS_WRONG_SIMILAR)
    elapsed_4 = time.perf_counter() - t0
    total_time += elapsed_4
    print_scores(scores_4, "Test 4: Wrong-but-similar labels (Python note, JS/TS distractors)")
    r = rank_of_label(scores_4, "Python Decorators")
    if r is not None:
        py_score = score_of_label(scores_4, "Python Decorators")
        js_score = score_of_label(scores_4, "JavaScript Decorators")
        ts_score = score_of_label(scores_4, "TypeScript Decorators")
        if py_score is not None:
            print(f"  'Python Decorators' rank: {r}, score: {py_score:.4f}")
        if js_score is not None:
            print(f"  vs JavaScript Decorators: {js_score:.4f}")
        if ts_score is not None:
            print(f"  vs TypeScript Decorators: {ts_score:.4f}")
    print(f"  Time: {elapsed_4:.4f}s")

    # -----------------------------------------------------------------------
    # Test 5: Very short note
    # -----------------------------------------------------------------------
    t0 = time.perf_counter()
    scores_5 = run_retrieval(model, NOTE_SHORT, LABELS_SHORT_NOTE)
    elapsed_5 = time.perf_counter() - t0
    total_time += elapsed_5
    print_scores(scores_5, "Test 5: Very short note")
    r = rank_of_label(scores_5, "Python Decorators")
    s = score_of_label(scores_5, "Python Decorators")
    if r is not None and s is not None:
        print(f"  'Python Decorators' rank: {r}, score: {s:.4f}")
    print(f"  Time: {elapsed_5:.4f}s")

    # -----------------------------------------------------------------------
    # Test 6: Ambiguous note (two plausible labels)
    # -----------------------------------------------------------------------
    t0 = time.perf_counter()
    scores_6 = run_retrieval(model, NOTE_AMBIGUOUS, LABELS_AMBIGUOUS)
    elapsed_6 = time.perf_counter() - t0
    total_time += elapsed_6
    print_scores(scores_6, "Test 6: Ambiguous note (async + performance)")
    print(f"  Time: {elapsed_6:.4f}s")

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Total inference time (after load): {total_time:.4f}s")
    print("\nPass criteria (for your review):")
    print("  Test 1: 'Python Decorators' should be top or near-top among near-duplicates.")
    print("  Test 2: Generic note – expect small gap; top label may vary.")
    print("  Test 3: 'Database Indexes' should be top-3 (ideally #1) among 20 labels.")
    print("  Test 4: 'Python Decorators' should beat JavaScript/TypeScript.")
    print("  Test 5: Short note – 'Python Decorators' should still lead.")
    print("  Test 6: Ambiguous – top 2 should be async and performance related.")


if __name__ == "__main__":
    main()
