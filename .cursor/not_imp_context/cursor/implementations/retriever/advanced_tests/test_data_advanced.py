# Advanced test data for mxbai retriever. Hard cases and edge cases.

# ---------------------------------------------------------------------------
# Test 1: Near-duplicate labels (labels are almost the same concept)
# Note is clearly about decorators. Correct: "Python Decorators" or first equivalent.
# ---------------------------------------------------------------------------
NOTE_DECORATORS = (
    "Python decorators are a powerful feature that allows you to wrap functions or methods "
    "in another function. The decorator function receives the original function as an argument "
    "and can execute code before and after calling it. This is commonly used for logging, "
    "authentication, caching, and validation. Decorators help you follow the DRY principle "
    "by keeping cross-cutting concerns in one place. To create a decorator, you define a "
    "function that takes a function as input and returns a new function. The @ symbol syntax "
    "is just shorthand for applying the decorator to the function below it. Understanding "
    "decorators also helps with understanding closures and how functions are first-class "
    "objects in Python."
)

# Labels are different phrasings of the same/similar concepts. Only one is the "file name" we want.
LABELS_NEAR_DUPLICATE = [
    "Python Decorators",
    "Python Decorator Pattern",
    "Function Decorators in Python",
    "Python Metaprogramming and Decorators",
    "Python Wrappers and Decorators",
]

# ---------------------------------------------------------------------------
# Test 2: Generic note (note could fit many labels; all labels are related)
# Expected: scores may cluster; gap between 1st and 2nd may be small.
# ---------------------------------------------------------------------------
NOTE_GENERIC = (
    "Python has many features that help with writing clean code. Functions are first-class "
    "objects. You can pass them around, return them, and wrap them. Best practices include "
    "using decorators for cross-cutting concerns and following design patterns. Scope and "
    "closures matter when you nest functions. Metaprogramming and the @ syntax are useful "
    "for reducing boilerplate. Learning these topics together gives a solid foundation."
)

LABELS_GENERIC = [
    "Python Decorators",
    "Python Functions and Scope",
    "Python Metaprogramming",
    "Python Design Patterns",
    "Python Best Practices",
]

# ---------------------------------------------------------------------------
# Test 3: Max label set (20 labels) – DRIP uses max ~20 at a time
# Correct label is "Database Indexes". Others are DB/backend topics.
# ---------------------------------------------------------------------------
NOTE_DATABASE_INDEXES = (
    "Database indexes are structures that improve the speed of data retrieval at the cost of "
    "additional storage and slower writes. A B-tree index is common for range queries. "
    "Composite indexes order columns left-to-right; the order matters for query performance. "
    "Covering indexes include all columns needed by the query so the table does not need to be "
    "accessed. Over-indexing can hurt write performance. Analyzing query plans helps decide "
    "which indexes to create."
)

LABELS_20 = [
    "Database Indexes",
    "Database Normalization",
    "SQL Queries and Joins",
    "Transaction Isolation Levels",
    "Database Sharding",
    "Connection Pooling",
    "Query Optimization",
    "Schema Design",
    "ACID Properties",
    "NoSQL vs SQL",
    "Database Migrations",
    "Stored Procedures",
    "Database Backup and Recovery",
    "Replication and Failover",
    "Database Security",
    "Caching Strategies",
    "ORM and N+1 Problem",
    "Database Locking",
    "Index Types and Use Cases",
    "Data Modeling",
]

# ---------------------------------------------------------------------------
# Test 4: Wrong-but-similar label (distractor from another language)
# Note is Python; one label is JavaScript. Correct: Python Decorators.
# ---------------------------------------------------------------------------
NOTE_PYTHON_DECORATORS_SHORT = (
    "In Python, decorators wrap a function to add behavior. The @decorator syntax applies "
    "a decorator to the function below. Common uses: logging, timing, caching, and auth checks."
)

LABELS_WRONG_SIMILAR = [
    "Python Decorators",
    "JavaScript Decorators",
    "Python Functions and Scope",
    "Python Metaprogramming",
    "TypeScript Decorators",
]

# ---------------------------------------------------------------------------
# Test 5: Very short note (minimal context)
# Expected: model may be less confident; scores might be closer.
# ---------------------------------------------------------------------------
NOTE_SHORT = (
    "Decorators wrap functions. Used for logging and caching in Python."
)

LABELS_SHORT_NOTE = [
    "Python Decorators",
    "Python Logging",
    "Python Caching",
    "Python Functions",
    "Python Best Practices",
]

# ---------------------------------------------------------------------------
# Test 6: Ambiguous note (could legitimately go in 2 places)
# Note mentions both async and performance. Correct could be either.
# ---------------------------------------------------------------------------
NOTE_AMBIGUOUS = (
    "When you have I/O-bound work, async and await let you run many operations concurrently "
    "without blocking. This improves throughput. You still need to think about CPU-bound "
    "tasks and when to use multiprocessing. Profiling helps find bottlenecks in both I/O "
    "and CPU. Use asyncio for network and file I/O; use ProcessPoolExecutor for heavy computation."
)

LABELS_AMBIGUOUS = [
    "Async Programming and Concurrency",
    "Performance and Profiling",
    "Python asyncio",
    "Multiprocessing vs Threading",
    "I/O and CPU Bound Tasks",
]

if __name__ == "__main__":
    print("This file only defines test data (notes and labels).")
    print("To run the advanced tests, use:  python test_mxbai_advanced.py")
