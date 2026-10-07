"""
Test sentence-transformers: all-MiniLM-L6-v2. Lightweight, CPU-friendly.
Run: pip install sentence-transformers
"""
import time
from sentence_transformers import SentenceTransformer, util
from test_data import NOTE, LABELS_OBVIOUS, LABELS_HARD


def run_situation(model, note: str, labels: list[str], situation_name: str) -> float:
    t0 = time.perf_counter()
    note_emb = model.encode(note)
    label_embs = model.encode(labels)
    similarities = util.cos_sim(note_emb, label_embs)[0]
    t1 = time.perf_counter()
    scores = [(labels[i], float(similarities[i])) for i in range(len(labels))]
    scores.sort(key=lambda x: x[1], reverse=True)
    elapsed = t1 - t0
    print(f"\n--- {situation_name} ---")
    for label, score in scores:
        print(f"  {label}: {score:.4f}")
    print(f"  Time (after load): {elapsed:.4f}s")
    return elapsed


def main():
    print("Loading sentence-transformers/all-MiniLM-L6-v2...")
    model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    print("Model loaded.\n")

    print("Note (first 80 chars):", NOTE[:80] + "...")

    time_a = run_situation(model, NOTE, LABELS_OBVIOUS, "Situation A (obvious choice)")
    time_b = run_situation(model, NOTE, LABELS_HARD, "Situation B (hard to differentiate)")

    print(f"\nTotal inference time (after load): {time_a + time_b:.4f}s")


if __name__ == "__main__":
    main()
