"""
Test FastEmbed (BGE-small via ONNX). CPU-only, minimal dependencies.
Run: pip install fastembed
"""
import time
import numpy as np
from test_data import NOTE, LABELS_OBVIOUS, LABELS_HARD


def cos_sim(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def run_situation(model, note: str, labels: list[str], situation_name: str) -> float:
    docs = [note] + labels
    t0 = time.perf_counter()
    embeddings = list(model.embed(docs))
    t1 = time.perf_counter()
    note_emb = np.array(embeddings[0])
    label_embs = [np.array(embeddings[i]) for i in range(1, len(docs))]
    scores = [(labels[i], cos_sim(note_emb, label_embs[i])) for i in range(len(labels))]
    scores.sort(key=lambda x: x[1], reverse=True)
    elapsed = t1 - t0
    print(f"\n--- {situation_name} ---")
    for label, score in scores:
        print(f"  {label}: {score:.4f}")
    print(f"  Time (after load): {elapsed:.4f}s")
    return elapsed


def main():
    print("Loading FastEmbed (BAAI/bge-small-en-v1.5)...")
    from fastembed import TextEmbedding
    model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
    print("Model loaded.\n")

    print("Note (first 80 chars):", NOTE[:80] + "...")

    time_a = run_situation(model, NOTE, LABELS_OBVIOUS, "Situation A (obvious choice)")
    time_b = run_situation(model, NOTE, LABELS_HARD, "Situation B (hard to differentiate)")

    print(f"\nTotal inference time (after load): {time_a + time_b:.4f}s")


if __name__ == "__main__":
    main()
