import XCTest
@testable import Basic

final class BasicTests: XCTestCase {
    func testAdd() {
        XCTAssertEqual(add(1, 2), 3)
    }
}
