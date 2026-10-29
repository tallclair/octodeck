# OctoDeck Backend

## Guidelines for Contribution

When implementing changes always adhere to the following principles:

- **Follow Requirements**: Carefully follow the user's requirements to the letter.
- **Plan First**: For any non-trivial change, first describe a detailed, step-by-step plan, including the files you intend to modify and the tests you will add or update.
- **Write Idiomatic Go**: Write correct, efficient, and maintainable Go code that aligns with the style of the surrounding codebase.
- **Test Thoroughly**: Implement comprehensive tests to ensure correctness and prevent regressions.
- **Comment Intelligently**: Add comments to explain the "why" behind complex or non-obvious code, keeping in mind that the reader may not be a Kubernetes expert.
- **Prioritize Correctness**: Always prioritize security, scalability, and maintainability in your implementations.

## Project Conventions and Workflow

Always adhere to the following project conventions:

- **Formatting**: Always format your code with `goimports -w`
- **Testing**:
  - All new features or bug fixes must be accompanied by appropriate tests.
  - Always run all unit tests before declaring a task complete.
  - Run all tests with `go test ./...`
  - Use `testify/assert` and `testify/require` to verify test assertions.
