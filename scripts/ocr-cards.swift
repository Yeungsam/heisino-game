import AppKit
import Foundation
import Vision

struct OCRLine: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OCRCard: Codable {
    let sourceFile: String
    let width: Int
    let height: Int
    let lines: [OCRLine]
}

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("Usage: swift scripts/ocr-cards.swift <image-directory> <output-json>\n".utf8))
    exit(2)
}

let inputDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let fileManager = FileManager.default
let imageURLs = try fileManager.contentsOfDirectory(
    at: inputDirectory,
    includingPropertiesForKeys: nil,
    options: [.skipsHiddenFiles]
).filter { $0.pathExtension.lowercased() == "png" }
 .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }

var cards: [OCRCard] = []
for (index, imageURL) in imageURLs.enumerated() {
    autoreleasepool {
        guard
            let image = NSImage(contentsOf: imageURL),
            let bitmap = NSBitmapImageRep(data: image.tiffRepresentation ?? Data()),
            let cgImage = bitmap.cgImage
        else {
            FileHandle.standardError.write(Data("Unable to load \(imageURL.lastPathComponent)\n".utf8))
            return
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        request.minimumTextHeight = 0.012

        do {
            try VNImageRequestHandler(url: imageURL, options: [:]).perform([request])
            let lines = (request.results ?? []).compactMap { observation -> OCRLine? in
                guard let candidate = observation.topCandidates(1).first else { return nil }
                let box = observation.boundingBox
                return OCRLine(
                    text: candidate.string,
                    confidence: candidate.confidence,
                    x: box.origin.x,
                    y: box.origin.y,
                    width: box.size.width,
                    height: box.size.height
                )
            }.sorted {
                if abs($0.y - $1.y) > 0.02 { return $0.y > $1.y }
                return $0.x < $1.x
            }
            cards.append(OCRCard(
                sourceFile: imageURL.lastPathComponent,
                width: cgImage.width,
                height: cgImage.height,
                lines: lines
            ))
            FileHandle.standardError.write(Data("[\(index + 1)/\(imageURLs.count)] \(imageURL.lastPathComponent): \(lines.count) lines\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("OCR failed for \(imageURL.lastPathComponent): \(error)\n".utf8))
        }
    }
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
let payload = try encoder.encode(cards)
try fileManager.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try payload.write(to: outputURL, options: .atomic)
