# Shared test data for all retriever model tests. Same note and labels across all scripts.

# Note: 100+ words (DRIP-style: where should this note be stored?)
NOTE = (
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

# Situation A: Labels are very different. Note clearly belongs to only one (Python Basics).
LABELS_OBVIOUS = [
    "Python Basics",
    "JavaScript Async Programming",
    "Database Normalization",
    "Networking Concepts",
    "Software Design Principles",
]

# Situation B: Labels are closely related. Note belongs to one but differentiating is hard.
LABELS_HARD = [
    "Python Decorators",
    "Python Functions and Scope",
    "Python Metaprogramming",
    "Python Design Patterns",
    "Python Best Practices",
]
