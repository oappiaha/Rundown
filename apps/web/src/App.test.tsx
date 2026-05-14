import { render, screen } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"
import App from "./App"

beforeEach(() => {
  globalThis.fetch = vi.fn((url: string) => {
    if (url.includes("/health")) {
      return Promise.resolve(new Response(JSON.stringify({ status: "ok" })))
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          topics: [{ text: "TEST TOPIC", duration: 60 }],
          hash: "abc12345",
        }),
      ),
    )
  }) as unknown as typeof fetch
})

test("renders header + a topic from the API", async () => {
  render(<App />)
  expect(screen.getByText("RUNDOWN")).toBeInTheDocument()
  expect(await screen.findByText("TEST TOPIC")).toBeInTheDocument()
  expect(screen.getByText("60s")).toBeInTheDocument()
})
