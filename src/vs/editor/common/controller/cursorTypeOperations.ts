/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { onUnexpectedError } from 'vs/base/common/errors';
import { ReplaceCommand, ReplaceCommandWithoutChangingPosition, ReplaceCommandWithOffsetCursorState, ReplaceCommandThatPreservesSelection } from 'vs/editor/common/commands/replaceCommand';
import { SingleCursorState, EditOperationResult, CursorColumns, CursorConfiguration, ICursorSimpleModel } from 'vs/editor/common/controller/cursorCommon';
import { Range } from 'vs/editor/common/core/range';
import { CursorChangeReason, ICommand } from 'vs/editor/common/editorCommon';
import * as strings from 'vs/base/common/strings';
import { ShiftCommand } from 'vs/editor/common/commands/shiftCommand';
import { Selection } from 'vs/editor/common/core/selection';
import { LanguageConfigurationRegistry } from 'vs/editor/common/modes/languageConfigurationRegistry';
import { ITokenizedModel } from 'vs/editor/common/editorCommon';
import { IndentAction } from 'vs/editor/common/modes/languageConfiguration';
import { CharCode } from 'vs/base/common/charCode';
import { SurroundSelectionCommand } from 'vs/editor/common/commands/surroundSelectionCommand';
import { IElectricAction } from 'vs/editor/common/modes/supports/electricCharacter';

export class TypeOperations {

	public static indent(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState): EditOperationResult {
		return new EditOperationResult(
			new ShiftCommand(cursor.selection, {
				isUnshift: false,
				tabSize: config.tabSize,
				oneIndent: config.oneIndent
			}), {
				shouldPushStackElementBefore: true,
				shouldPushStackElementAfter: true,
				shouldRevealHorizontal: false
			}
		);
	}

	public static outdent(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState): EditOperationResult {
		return new EditOperationResult(
			new ShiftCommand(cursor.selection, {
				isUnshift: true,
				tabSize: config.tabSize,
				oneIndent: config.oneIndent
			}), {
				shouldPushStackElementBefore: true,
				shouldPushStackElementAfter: true,
				shouldRevealHorizontal: false
			}
		);
	}

	public static paste(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, text: string, pasteOnNewLine: boolean): EditOperationResult {
		let position = cursor.position;
		let selection = cursor.selection;

		if (pasteOnNewLine && text.indexOf('\n') !== text.length - 1) {
			pasteOnNewLine = false;
		}
		if (pasteOnNewLine && selection.startLineNumber !== selection.endLineNumber) {
			pasteOnNewLine = false;
		}
		if (pasteOnNewLine && selection.startColumn === model.getLineMinColumn(selection.startLineNumber) && selection.endColumn === model.getLineMaxColumn(selection.startLineNumber)) {
			pasteOnNewLine = false;
		}

		if (pasteOnNewLine) {
			// Paste entire line at the beginning of line

			let typeSelection = new Range(position.lineNumber, 1, position.lineNumber, 1);
			return new EditOperationResult(new ReplaceCommand(typeSelection, text), {
				shouldPushStackElementBefore: true,
				shouldPushStackElementAfter: true,
				cursorPositionChangeReason: CursorChangeReason.Paste
			});
		}

		return new EditOperationResult(new ReplaceCommand(selection, text), {
			shouldPushStackElementBefore: true,
			shouldPushStackElementAfter: true,
			cursorPositionChangeReason: CursorChangeReason.Paste
		});
	}

	private static _goodIndentForLine(config: CursorConfiguration, model: ITokenizedModel, lineNumber: number): string {
		let lastLineNumber = lineNumber - 1;

		for (lastLineNumber = lineNumber - 1; lastLineNumber >= 1; lastLineNumber--) {
			let lineText = model.getLineContent(lastLineNumber);
			let nonWhitespaceIdx = strings.lastNonWhitespaceIndex(lineText);
			if (nonWhitespaceIdx >= 0) {
				break;
			}
		}

		if (lastLineNumber < 1) {
			// No previous line with content found
			return '\t';
		}

		let r = LanguageConfigurationRegistry.getEnterActionAtPosition(model, lastLineNumber, model.getLineMaxColumn(lastLineNumber));

		let indentation: string;
		if (r.enterAction.indentAction === IndentAction.Outdent) {
			let desiredIndentCount = ShiftCommand.unshiftIndentCount(r.indentation, r.indentation.length, config.tabSize);
			indentation = '';
			for (let i = 0; i < desiredIndentCount; i++) {
				indentation += '\t';
			}
			indentation = config.normalizeIndentation(indentation);
		} else {
			indentation = r.indentation;
		}

		let result = indentation + r.enterAction.appendText;
		if (result.length === 0) {
			// good position is at column 1, but we gotta do something...
			return '\t';
		}
		return result;
	}

	private static _replaceJumpToNextIndent(config: CursorConfiguration, model: ICursorSimpleModel, selection: Selection): ReplaceCommand {
		let typeText = '';

		let position = selection.getStartPosition();
		if (config.insertSpaces) {
			let visibleColumnFromColumn = CursorColumns.visibleColumnFromColumn2(config, model, position);
			let tabSize = config.tabSize;
			let spacesCnt = tabSize - (visibleColumnFromColumn % tabSize);
			for (let i = 0; i < spacesCnt; i++) {
				typeText += ' ';
			}
		} else {
			typeText = '\t';
		}

		return new ReplaceCommand(selection, typeText);
	}

	public static tab(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState): EditOperationResult {
		let selection = cursor.selection;

		if (selection.isEmpty()) {

			let lineText = model.getLineContent(selection.startLineNumber);

			if (/^\s*$/.test(lineText)) {
				let possibleTypeText = config.normalizeIndentation(this._goodIndentForLine(config, model, selection.startLineNumber));
				if (!strings.startsWith(lineText, possibleTypeText)) {
					let command = new ReplaceCommand(new Range(selection.startLineNumber, 1, selection.startLineNumber, lineText.length + 1), possibleTypeText);
					return new EditOperationResult(command, {
						shouldPushStackElementBefore: false,
						shouldPushStackElementAfter: false,
						isAutoWhitespaceCommand: true
					});
				}
			}

			return new EditOperationResult(this._replaceJumpToNextIndent(config, model, selection), {
				shouldPushStackElementBefore: false,
				shouldPushStackElementAfter: false,
				isAutoWhitespaceCommand: true
			});
		} else {
			if (selection.startLineNumber === selection.endLineNumber) {
				let lineMaxColumn = model.getLineMaxColumn(selection.startLineNumber);
				if (selection.startColumn !== 1 || selection.endColumn !== lineMaxColumn) {
					// This is a single line selection that is not the entire line
					return new EditOperationResult(this._replaceJumpToNextIndent(config, model, selection), {
						shouldPushStackElementBefore: false,
						shouldPushStackElementAfter: false
					});
				}
			}

			return this.indent(config, model, cursor);
		}
	}

	public static replacePreviousChar(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState, txt: string, replaceCharCnt: number): EditOperationResult {
		let pos = cursor.position;
		let startColumn = Math.max(1, pos.column - replaceCharCnt);
		let range = new Range(pos.lineNumber, startColumn, pos.lineNumber, pos.column);
		return new EditOperationResult(new ReplaceCommand(range, txt), {
			shouldPushStackElementBefore: false,
			shouldPushStackElementAfter: false
		});
	}

	public static typeCommand(range: Range, text: string, keepPosition: boolean): ICommand {
		if (keepPosition) {
			return new ReplaceCommandWithoutChangingPosition(range, text);
		} else {
			return new ReplaceCommand(range, text);
		}
	}

	private static _enter(config: CursorConfiguration, model: ITokenizedModel, keepPosition: boolean, range: Range): EditOperationResult {

		let r = LanguageConfigurationRegistry.getEnterActionAtPosition(model, range.startLineNumber, range.startColumn);
		let enterAction = r.enterAction;
		let indentation = r.indentation;

		let executeCommand: ICommand;
		if (enterAction.indentAction === IndentAction.None) {
			// Nothing special
			executeCommand = TypeOperations.typeCommand(range, '\n' + config.normalizeIndentation(indentation + enterAction.appendText), keepPosition);

		} else if (enterAction.indentAction === IndentAction.Indent) {
			// Indent once
			executeCommand = TypeOperations.typeCommand(range, '\n' + config.normalizeIndentation(indentation + enterAction.appendText), keepPosition);

		} else if (enterAction.indentAction === IndentAction.IndentOutdent) {
			// Ultra special
			let normalIndent = config.normalizeIndentation(indentation);
			let increasedIndent = config.normalizeIndentation(indentation + enterAction.appendText);

			let typeText = '\n' + increasedIndent + '\n' + normalIndent;

			if (keepPosition) {
				executeCommand = new ReplaceCommandWithoutChangingPosition(range, typeText);
			} else {
				executeCommand = new ReplaceCommandWithOffsetCursorState(range, typeText, -1, increasedIndent.length - normalIndent.length);
			}
		} else if (enterAction.indentAction === IndentAction.Outdent) {
			let desiredIndentCount = ShiftCommand.unshiftIndentCount(indentation, indentation.length + 1, config.tabSize);
			let actualIndentation = '';
			for (let i = 0; i < desiredIndentCount; i++) {
				actualIndentation += '\t';
			}
			executeCommand = TypeOperations.typeCommand(range, '\n' + config.normalizeIndentation(actualIndentation + enterAction.appendText), keepPosition);
		}

		return new EditOperationResult(executeCommand, {
			shouldPushStackElementBefore: true,
			shouldPushStackElementAfter: false,
			isAutoWhitespaceCommand: true
		});
	}

	private static _typeInterceptorEnter(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState, ch: string): EditOperationResult {
		if (ch !== '\n') {
			return null;
		}

		return TypeOperations._enter(config, model, false, cursor.selection);
	}

	private static _typeInterceptorAutoClosingCloseChar(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState, ch: string): EditOperationResult {
		if (!config.autoClosingBrackets) {
			return null;
		}

		let selection = cursor.selection;

		if (!selection.isEmpty() || !config.autoClosingPairsClose.hasOwnProperty(ch)) {
			return null;
		}

		let position = cursor.position;

		let lineText = model.getLineContent(position.lineNumber);
		let beforeCharacter = lineText.charAt(position.column - 1);

		if (beforeCharacter !== ch) {
			return null;
		}

		let typeSelection = new Range(position.lineNumber, position.column, position.lineNumber, position.column + 1);
		return new EditOperationResult(new ReplaceCommand(typeSelection, ch), {
			shouldPushStackElementBefore: false,
			shouldPushStackElementAfter: false
		});
	}

	private static _typeInterceptorAutoClosingOpenChar(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState, ch: string): EditOperationResult {
		if (!config.autoClosingBrackets) {
			return null;
		}

		let selection = cursor.selection;

		if (!selection.isEmpty() || !config.autoClosingPairsOpen.hasOwnProperty(ch)) {
			return null;
		}

		let position = cursor.position;
		let lineText = model.getLineContent(position.lineNumber);
		let beforeCharacter = lineText.charAt(position.column - 1);

		// Only consider auto closing the pair if a space follows or if another autoclosed pair follows
		if (beforeCharacter) {
			let isBeforeCloseBrace = false;
			for (let closeBrace in config.autoClosingPairsClose) {
				if (beforeCharacter === closeBrace) {
					isBeforeCloseBrace = true;
					break;
				}
			}
			if (!isBeforeCloseBrace && !/\s/.test(beforeCharacter)) {
				return null;
			}
		}

		let lineTokens = model.getLineTokens(position.lineNumber, false);

		let shouldAutoClosePair = false;
		try {
			shouldAutoClosePair = LanguageConfigurationRegistry.shouldAutoClosePair(ch, lineTokens, position.column);
		} catch (e) {
			onUnexpectedError(e);
		}

		if (!shouldAutoClosePair) {
			return null;
		}

		let closeCharacter = config.autoClosingPairsOpen[ch];
		return new EditOperationResult(new ReplaceCommandWithOffsetCursorState(selection, ch + closeCharacter, 0, -closeCharacter.length), {
			shouldPushStackElementBefore: true,
			shouldPushStackElementAfter: false
		});
	}

	private static _typeInterceptorSurroundSelection(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState, ch: string): EditOperationResult {
		if (!config.autoClosingBrackets) {
			return null;
		}

		let selection = cursor.selection;

		if (selection.isEmpty() || !config.surroundingPairs.hasOwnProperty(ch)) {
			return null;
		}

		let selectionContainsOnlyWhitespace = true;

		for (let lineNumber = selection.startLineNumber; lineNumber <= selection.endLineNumber; lineNumber++) {
			let lineText = model.getLineContent(lineNumber);
			let startIndex = (lineNumber === selection.startLineNumber ? selection.startColumn - 1 : 0);
			let endIndex = (lineNumber === selection.endLineNumber ? selection.endColumn - 1 : lineText.length);
			for (let charIndex = startIndex; charIndex < endIndex; charIndex++) {
				let charCode = lineText.charCodeAt(charIndex);
				if (charCode !== CharCode.Tab && charCode !== CharCode.Space) {
					selectionContainsOnlyWhitespace = false;

					// Break outer loop
					lineNumber = selection.endLineNumber + 1;

					// Break inner loop
					charIndex = endIndex;
				}
			}
		}

		if (selectionContainsOnlyWhitespace) {
			return null;
		}

		let closeCharacter = config.surroundingPairs[ch];

		return new EditOperationResult(new SurroundSelectionCommand(selection, ch, closeCharacter), {
			shouldPushStackElementBefore: true,
			shouldPushStackElementAfter: true
		});
	}

	private static _typeInterceptorElectricChar(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState, ch: string): EditOperationResult {
		if (!config.electricChars.hasOwnProperty(ch)) {
			return null;
		}

		let position = cursor.position;
		let lineTokens = model.getLineTokens(position.lineNumber, false);

		let electricAction: IElectricAction;
		try {
			electricAction = LanguageConfigurationRegistry.onElectricCharacter(ch, lineTokens, position.column);
		} catch (e) {
			onUnexpectedError(e);
		}

		if (!electricAction) {
			return null;
		}

		if (electricAction.appendText) {
			return new EditOperationResult(new ReplaceCommandWithOffsetCursorState(cursor.selection, ch + electricAction.appendText, 0, -electricAction.appendText.length), {
				shouldPushStackElementBefore: false,
				shouldPushStackElementAfter: true
			});
		}

		if (electricAction.matchOpenBracket) {
			let match = model.findMatchingBracketUp(electricAction.matchOpenBracket, {
				lineNumber: position.lineNumber,
				column: position.column
			});

			if (match) {
				let matchLine = model.getLineContent(match.startLineNumber);
				let matchLineIndentation = strings.getLeadingWhitespace(matchLine);
				let newIndentation = config.normalizeIndentation(matchLineIndentation);

				let lineText = model.getLineContent(position.lineNumber);
				let lineFirstNonBlankColumn = model.getLineFirstNonWhitespaceColumn(position.lineNumber) || position.column;

				let prefix = lineText.substring(lineFirstNonBlankColumn - 1, position.column - 1);
				let typeText = newIndentation + prefix + ch;

				let typeSelection = new Range(position.lineNumber, 1, position.lineNumber, position.column);

				return new EditOperationResult(new ReplaceCommand(typeSelection, typeText), {
					shouldPushStackElementBefore: false,
					shouldPushStackElementAfter: true
				});
			}
		}

		return null;
	}

	public static typeWithInterceptors(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState, ch: string): EditOperationResult {
		let r: EditOperationResult = null;

		r = r || this._typeInterceptorEnter(config, model, cursor, ch);
		r = r || this._typeInterceptorAutoClosingCloseChar(config, model, cursor, ch);
		r = r || this._typeInterceptorAutoClosingOpenChar(config, model, cursor, ch);
		r = r || this._typeInterceptorSurroundSelection(config, model, cursor, ch);
		r = r || this._typeInterceptorElectricChar(config, model, cursor, ch);
		r = r || this.typeWithoutInterceptors(config, model, cursor, ch);

		return r;
	}

	public static typeWithoutInterceptors(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState, str: string): EditOperationResult {
		return new EditOperationResult(TypeOperations.typeCommand(cursor.selection, str, false), {
			shouldPushStackElementBefore: false,
			shouldPushStackElementAfter: false
		});
	}

	public static lineInsertBefore(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState): EditOperationResult {
		let lineNumber = cursor.position.lineNumber;

		if (lineNumber === 1) {
			return new EditOperationResult(new ReplaceCommandWithoutChangingPosition(new Range(1, 1, 1, 1), '\n'), {
				shouldPushStackElementBefore: true,
				shouldPushStackElementAfter: true
			});
		}

		lineNumber--;
		let column = model.getLineMaxColumn(lineNumber);

		return this._enter(config, model, false, new Range(lineNumber, column, lineNumber, column));
	}

	public static lineInsertAfter(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState): EditOperationResult {
		let position = cursor.position;
		let column = model.getLineMaxColumn(position.lineNumber);
		return this._enter(config, model, false, new Range(position.lineNumber, column, position.lineNumber, column));
	}

	public static lineBreakInsert(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState): EditOperationResult {
		return this._enter(config, model, true, cursor.selection);
	}

	public static joinLines(config: CursorConfiguration, model: ITokenizedModel, cursor: SingleCursorState): EditOperationResult {
		let selection = cursor.selection;
		let position = cursor.position;
		let startLineNumber: number,
			startColumn: number,
			endLineNumber: number,
			endColumn: number,
			columnDeltaOffset;

		if (selection.isEmpty() || selection.startLineNumber === selection.endLineNumber) {
			if (position.lineNumber < model.getLineCount()) {
				startLineNumber = position.lineNumber;
				startColumn = 1;
				endLineNumber = startLineNumber + 1;
				endColumn = model.getLineMaxColumn(endLineNumber);
			} else {
				startLineNumber = position.lineNumber;
				startColumn = 1;
				endLineNumber = position.lineNumber;
				endColumn = model.getLineMaxColumn(position.lineNumber);
			}
		} else {
			startLineNumber = selection.startLineNumber;
			startColumn = 1;
			endLineNumber = selection.endLineNumber;
			endColumn = model.getLineMaxColumn(endLineNumber);
		}

		let trimmedLinesContent = model.getLineContent(startLineNumber);

		for (let i = startLineNumber + 1; i <= endLineNumber; i++) {
			let lineText = model.getLineContent(i);
			let firstNonWhitespaceIdx = strings.firstNonWhitespaceIndex(lineText);

			if (firstNonWhitespaceIdx >= 0) {
				let insertSpace = true;

				if (trimmedLinesContent === '' || trimmedLinesContent.charAt(trimmedLinesContent.length - 1) === ' ') {
					insertSpace = false;
				}

				let lineTextWithoutIndent = lineText.substr(firstNonWhitespaceIdx);

				if (lineTextWithoutIndent.charAt(0) === ')') {
					insertSpace = false;
				}

				trimmedLinesContent += (insertSpace ? ' ' : '') + lineTextWithoutIndent;

				if (insertSpace) {
					columnDeltaOffset = lineTextWithoutIndent.length + 1;
				} else {
					columnDeltaOffset = lineTextWithoutIndent.length;
				}
			} else {
				columnDeltaOffset = 0;
			}
		}

		let deleteSelection = new Range(
			startLineNumber,
			startColumn,
			endLineNumber,
			endColumn
		);

		if (!deleteSelection.isEmpty()) {
			if (!selection.isEmpty() && selection.startLineNumber === selection.endLineNumber) {
				return new EditOperationResult(new ReplaceCommandThatPreservesSelection(deleteSelection, trimmedLinesContent, selection), {
					shouldPushStackElementBefore: false,
					shouldPushStackElementAfter: false
				});
			} else {
				return new EditOperationResult(new ReplaceCommandWithOffsetCursorState(deleteSelection, trimmedLinesContent, 0, -columnDeltaOffset), {
					shouldPushStackElementBefore: false,
					shouldPushStackElementAfter: false
				});
			}
		}

		return null;
	}
}
