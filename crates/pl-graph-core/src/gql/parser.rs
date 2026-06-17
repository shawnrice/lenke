//! Recursive-descent parser: token stream → `Query` AST. Port of TS `parser.ts`.
//! ISO GQL precedence (loosest→tightest): OR/XOR, AND, NOT, IS/IN predicates,
//! comparison, `||`, +/-, *///%, unary, primary. Label expressions: `|` < `&` < `!`.

use super::ast::*;
use super::lexer::{err, is_reserved, tokenize, SyntaxError, Token, Tt};

pub fn parse(src: &str) -> Result<Query, SyntaxError> {
    let tokens = tokenize(src)?;
    let mut p = Parser { tokens, pos: 0 };
    p.parse_query()
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

type R<T> = Result<T, SyntaxError>;

impl Parser {
    fn peek(&self) -> &Token {
        &self.tokens[self.pos]
    }
    fn at_end(&self) -> bool {
        self.peek().tt == Tt::Eof
    }
    fn advance(&mut self) -> Token {
        let t = self.tokens[self.pos].clone();
        self.pos += 1;
        t
    }
    fn check(&self, tt: Tt) -> bool {
        self.peek().tt == tt
    }
    fn check_kw(&self, kw: &str) -> bool {
        let t = self.peek();
        t.tt == Tt::Keyword && t.value == kw
    }
    /// A non-reserved keyword that arrives as an `ident` (LABELED, FIRST, LAST).
    fn check_soft(&self, word: &str) -> bool {
        let t = self.peek();
        t.tt == Tt::Ident && t.value.eq_ignore_ascii_case(word)
    }
    fn expect(&mut self, tt: Tt, what: &str) -> R<Token> {
        if !self.check(tt) {
            let t = self.peek();
            let got = if t.value.is_empty() {
                format!("{:?}", t.tt)
            } else {
                t.value.clone()
            };
            return err(format!("Expected {what}, got '{got}'"), t.pos);
        }
        Ok(self.advance())
    }
    fn expect_kw(&mut self, kw: &str) -> R<Token> {
        if !self.check_kw(kw) {
            let t = self.peek();
            let got = if t.value.is_empty() {
                format!("{:?}", t.tt)
            } else {
                t.value.clone()
            };
            return err(
                format!("Expected '{}', got '{got}'", kw.to_uppercase()),
                t.pos,
            );
        }
        Ok(self.advance())
    }

    /// Consume an identifier in a binding position (variable, label, key, alias).
    /// A bare reserved word is rejected; a delimited identifier may be any word.
    fn bind_name(&mut self, what: &str) -> R<String> {
        let tok = self.expect(Tt::Ident, what)?;
        if !tok.delimited && is_reserved(&tok.value) {
            return err(
                format!(
                    "'{}' is a reserved word; quote it as a delimited identifier",
                    tok.value
                ),
                tok.pos,
            );
        }
        Ok(tok.value)
    }

    // --- patterns ----------------------------------------------------------

    fn parse_property_map(&mut self) -> R<Vec<PropertyConstraint>> {
        self.expect(Tt::LBrace, "'{'")?;
        let mut props = Vec::new();
        if !self.check(Tt::RBrace) {
            loop {
                let key = self.bind_name("a property name")?;
                self.expect(Tt::Colon, "':'")?;
                props.push(PropertyConstraint {
                    key,
                    value: self.parse_expr()?,
                });
                if self.check(Tt::Comma) {
                    self.advance();
                } else {
                    break;
                }
            }
        }
        self.expect(Tt::RBrace, "'}'")?;
        Ok(props)
    }

    fn parse_predicate(&mut self) -> R<(Vec<PropertyConstraint>, Option<Expr>)> {
        let props = if self.check(Tt::LBrace) {
            self.parse_property_map()?
        } else {
            Vec::new()
        };
        let where_ = if self.check_kw("where") {
            self.advance();
            Some(self.parse_expr()?)
        } else {
            None
        };
        Ok((props, where_))
    }

    fn parse_node(&mut self) -> R<NodePattern> {
        self.expect(Tt::LParen, "'('")?;
        let variable = if self.check(Tt::Ident) {
            Some(self.bind_name("a variable")?)
        } else {
            None
        };
        let label = if self.check(Tt::Colon) || self.check_kw("is") {
            self.advance();
            Some(self.parse_label_expr()?)
        } else {
            None
        };
        let (props, where_) = self.parse_predicate()?;
        self.expect(Tt::RParen, "')'")?;
        Ok(NodePattern {
            variable,
            label,
            props,
            where_,
        })
    }

    fn parse_label_expr(&mut self) -> R<LabelExpr> {
        self.parse_label_or()
    }
    fn parse_label_or(&mut self) -> R<LabelExpr> {
        let mut left = self.parse_label_and()?;
        while self.check(Tt::Pipe) {
            self.advance();
            left = LabelExpr::Or(Box::new(left), Box::new(self.parse_label_and()?));
        }
        Ok(left)
    }
    fn parse_label_and(&mut self) -> R<LabelExpr> {
        let mut left = self.parse_label_not()?;
        while self.check(Tt::Amp) {
            self.advance();
            left = LabelExpr::And(Box::new(left), Box::new(self.parse_label_not()?));
        }
        Ok(left)
    }
    fn parse_label_not(&mut self) -> R<LabelExpr> {
        if self.check(Tt::Bang) {
            self.advance();
            return Ok(LabelExpr::Not(Box::new(self.parse_label_not()?)));
        }
        self.parse_label_primary()
    }
    fn parse_label_primary(&mut self) -> R<LabelExpr> {
        if self.check(Tt::Percent) {
            self.advance();
            return Ok(LabelExpr::Wildcard);
        }
        if self.check(Tt::LParen) {
            self.advance();
            let inner = self.parse_label_expr()?;
            self.expect(Tt::RParen, "')' to close a label expression")?;
            return Ok(inner);
        }
        Ok(LabelExpr::Label(self.bind_name("a label name")?))
    }

    fn parse_rel_detail(
        &mut self,
    ) -> R<(
        Option<String>,
        Option<LabelExpr>,
        Vec<PropertyConstraint>,
        Option<Expr>,
    )> {
        self.expect(Tt::LBracket, "'['")?;
        let variable = if self.check(Tt::Ident) {
            Some(self.bind_name("a variable")?)
        } else {
            None
        };
        let label = if self.check(Tt::Colon) || self.check_kw("is") {
            self.advance();
            Some(self.parse_label_expr()?)
        } else {
            None
        };
        let (props, where_) = self.parse_predicate()?;
        self.expect(Tt::RBracket, "']'")?;
        Ok((variable, label, props, where_))
    }

    fn parse_rel(&mut self) -> R<RelPattern> {
        // Pure abbreviated forms first: `->`, `<->`, `~>`.
        let abbrev = match self.peek().tt {
            Tt::RArrow => Some(Direction::Out),
            Tt::LRArrow => Some(Direction::Both),
            Tt::TildeR => Some(Direction::Both),
            _ => None,
        };
        if let Some(direction) = abbrev {
            self.advance();
            return Ok(RelPattern {
                variable: None,
                label: None,
                direction,
                props: Vec::new(),
                where_: None,
                quantifier: None,
            });
        }

        // Left marker.
        let mut left_arrow = false;
        if self.check(Tt::LArrow) {
            self.advance();
            left_arrow = true;
        } else if self.check(Tt::Dash) || self.check(Tt::Tilde) || self.check(Tt::LTilde) {
            self.advance();
        } else {
            let t = self.peek();
            let got = if t.value.is_empty() {
                format!("{:?}", t.tt)
            } else {
                t.value.clone()
            };
            return err(
                format!("Expected a relationship (e.g. -[:T]->, <-[:T]-, ~[:T]~, ->), got '{got}'"),
                t.pos,
            );
        }

        // No bracket → abbreviated edge.
        if !self.check(Tt::LBracket) {
            return Ok(RelPattern {
                variable: None,
                label: None,
                direction: if left_arrow {
                    Direction::In
                } else {
                    Direction::Both
                },
                props: Vec::new(),
                where_: None,
                quantifier: None,
            });
        }

        let (variable, label, props, where_) = self.parse_rel_detail()?;

        // Closing marker.
        let mut right_arrow = false;
        if self.check(Tt::RArrow) {
            self.advance();
            right_arrow = true;
        } else if self.check(Tt::Dash) || self.check(Tt::Tilde) || self.check(Tt::TildeR) {
            self.advance();
        } else {
            let t = self.peek();
            let got = if t.value.is_empty() {
                format!("{:?}", t.tt)
            } else {
                t.value.clone()
            };
            return err(
                format!("Expected ']->', ']-' or ']~' to close a relationship, got '{got}'"),
                t.pos,
            );
        }

        let direction = if right_arrow && !left_arrow {
            Direction::Out
        } else if left_arrow && !right_arrow {
            Direction::In
        } else {
            Direction::Both
        };
        Ok(RelPattern {
            variable,
            label,
            direction,
            props,
            where_,
            quantifier: None,
        })
    }

    fn starts_relationship(&self) -> bool {
        matches!(
            self.peek().tt,
            Tt::Dash | Tt::LArrow | Tt::RArrow | Tt::LRArrow | Tt::Tilde | Tt::LTilde | Tt::TildeR
        )
    }

    fn parse_quantifier(&mut self) -> R<Option<Quantifier>> {
        if self.check(Tt::Star) {
            self.advance();
            return Ok(Some(Quantifier { min: 0, max: None }));
        }
        if self.check(Tt::Plus) {
            self.advance();
            return Ok(Some(Quantifier { min: 1, max: None }));
        }
        if self.check(Tt::LBrace) {
            self.advance();
            let min = if self.check(Tt::Number) {
                self.advance().num.unwrap() as u32
            } else {
                0
            };
            let mut max = Some(min);
            if self.check(Tt::Comma) {
                self.advance();
                max = if self.check(Tt::Number) {
                    Some(self.advance().num.unwrap() as u32)
                } else {
                    None
                };
            }
            self.expect(Tt::RBrace, "'}' to close a quantifier")?;
            return Ok(Some(Quantifier { min, max }));
        }
        Ok(None)
    }

    fn parse_path_pattern(&mut self) -> R<PathPattern> {
        let start = self.parse_node()?;
        let mut segments = Vec::new();
        while self.starts_relationship() {
            let mut rel = self.parse_rel()?;
            rel.quantifier = self.parse_quantifier()?;
            let node = self.parse_node()?;
            segments.push(Segment { rel, node });
        }
        Ok(PathPattern { start, segments })
    }

    fn parse_match_clause(&mut self) -> R<MatchClause> {
        let optional = if self.check_kw("optional") {
            self.advance();
            true
        } else {
            false
        };
        self.expect_kw("match")?;
        let mut patterns = vec![self.parse_path_pattern()?];
        while self.check(Tt::Comma) {
            self.advance();
            patterns.push(self.parse_path_pattern()?);
        }
        let where_ = if self.check_kw("where") {
            self.advance();
            Some(self.parse_expr()?)
        } else {
            None
        };
        Ok(MatchClause {
            optional,
            patterns,
            where_,
        })
    }

    // --- expressions -------------------------------------------------------

    fn parse_expr(&mut self) -> R<Expr> {
        self.parse_or_xor()
    }

    fn parse_or_xor(&mut self) -> R<Expr> {
        let mut left = self.parse_and()?;
        while self.check_kw("or") || self.check_kw("xor") {
            let is_or = self.advance().value == "or";
            let right = self.parse_and()?;
            left = if is_or {
                Expr::Or(Box::new(left), Box::new(right))
            } else {
                Expr::Xor(Box::new(left), Box::new(right))
            };
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> R<Expr> {
        let mut left = self.parse_not()?;
        while self.check_kw("and") {
            self.advance();
            left = Expr::And(Box::new(left), Box::new(self.parse_not()?));
        }
        Ok(left)
    }

    fn parse_not(&mut self) -> R<Expr> {
        if self.check_kw("not") {
            self.advance();
            return Ok(Expr::Not(Box::new(self.parse_not()?)));
        }
        self.parse_postfix_predicate()
    }

    fn parse_postfix_predicate(&mut self) -> R<Expr> {
        let e = self.parse_comparison()?;
        if self.check_kw("is") {
            self.advance();
            let negated = if self.check_kw("not") {
                self.advance();
                true
            } else {
                false
            };
            if self.check_kw("null") {
                self.advance();
                return Ok(Expr::IsNull {
                    expr: Box::new(e),
                    negated,
                });
            }
            if self.check_kw("true") {
                self.advance();
                return Ok(Expr::IsTruth {
                    expr: Box::new(e),
                    truth: Some(true),
                    negated,
                });
            }
            if self.check_kw("false") {
                self.advance();
                return Ok(Expr::IsTruth {
                    expr: Box::new(e),
                    truth: Some(false),
                    negated,
                });
            }
            if self.check_kw("unknown") {
                self.advance();
                return Ok(Expr::IsTruth {
                    expr: Box::new(e),
                    truth: None,
                    negated,
                });
            }
            if self.check_soft("labeled") {
                self.advance();
                return Ok(Expr::IsLabeled {
                    expr: Box::new(e),
                    label: self.parse_label_expr()?,
                    negated,
                });
            }
            return err(
                "Expected NULL, TRUE, FALSE, UNKNOWN, or LABELED after IS",
                self.peek().pos,
            );
        }
        if self.check_kw("in") {
            self.advance();
            return Ok(Expr::In {
                expr: Box::new(e),
                list: Box::new(self.parse_unary()?),
                negated: false,
            });
        }
        if self.check_kw("not") {
            self.advance();
            self.expect_kw("in")?;
            return Ok(Expr::In {
                expr: Box::new(e),
                list: Box::new(self.parse_unary()?),
                negated: true,
            });
        }
        Ok(e)
    }

    fn parse_comparison(&mut self) -> R<Expr> {
        let left = self.parse_concat()?;
        let op = match self.peek().tt {
            Tt::Eq => Some(CompareOp::Eq),
            Tt::Neq => Some(CompareOp::Ne),
            Tt::Lt => Some(CompareOp::Lt),
            Tt::Gt => Some(CompareOp::Gt),
            Tt::Lte => Some(CompareOp::Le),
            Tt::Gte => Some(CompareOp::Ge),
            _ => None,
        };
        if let Some(op) = op {
            self.advance();
            return Ok(Expr::Compare {
                op,
                left: Box::new(left),
                right: Box::new(self.parse_concat()?),
            });
        }
        Ok(left)
    }

    fn parse_concat(&mut self) -> R<Expr> {
        let mut left = self.parse_additive()?;
        while self.check(Tt::Concat) {
            self.advance();
            left = Expr::Concat {
                left: Box::new(left),
                right: Box::new(self.parse_additive()?),
            };
        }
        Ok(left)
    }

    fn parse_additive(&mut self) -> R<Expr> {
        let mut left = self.parse_multiplicative()?;
        loop {
            let op = match self.peek().tt {
                Tt::Plus => Some(ArithOp::Add),
                Tt::Dash => Some(ArithOp::Sub),
                _ => None,
            };
            match op {
                Some(op) => {
                    self.advance();
                    left = Expr::Arith {
                        op,
                        left: Box::new(left),
                        right: Box::new(self.parse_multiplicative()?),
                    };
                }
                None => break,
            }
        }
        Ok(left)
    }

    fn parse_multiplicative(&mut self) -> R<Expr> {
        let mut left = self.parse_unary()?;
        loop {
            let op = match self.peek().tt {
                Tt::Star => Some(ArithOp::Mul),
                Tt::Slash => Some(ArithOp::Div),
                Tt::Percent => Some(ArithOp::Mod),
                _ => None,
            };
            match op {
                Some(op) => {
                    self.advance();
                    left = Expr::Arith {
                        op,
                        left: Box::new(left),
                        right: Box::new(self.parse_unary()?),
                    };
                }
                None => break,
            }
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> R<Expr> {
        if self.check(Tt::Dash) {
            self.advance();
            return Ok(Expr::Neg(Box::new(self.parse_unary()?)));
        }
        if self.check(Tt::Plus) {
            self.advance();
            return self.parse_unary();
        }
        self.parse_primary()
    }

    fn parse_braced_subquery(&mut self) -> R<(Vec<PathPattern>, Option<Expr>)> {
        self.expect(Tt::LBrace, "'{'")?;
        if self.check_kw("match") {
            self.advance();
        }
        let mut patterns = vec![self.parse_path_pattern()?];
        while self.check(Tt::Comma) {
            self.advance();
            patterns.push(self.parse_path_pattern()?);
        }
        let where_ = if self.check_kw("where") {
            self.advance();
            Some(self.parse_expr()?)
        } else {
            None
        };
        self.expect(Tt::RBrace, "'}'")?;
        Ok((patterns, where_))
    }

    fn parse_call_args(&mut self) -> R<(Vec<Expr>, bool, bool)> {
        self.expect(Tt::LParen, "'(' to open a function call")?;
        let mut star = false;
        let mut distinct = false;
        let mut args = Vec::new();
        if self.check(Tt::Star) {
            self.advance();
            star = true;
        } else if !self.check(Tt::RParen) {
            if self.check_kw("distinct") {
                self.advance();
                distinct = true;
            }
            args.push(self.parse_expr()?);
            while self.check(Tt::Comma) {
                self.advance();
                args.push(self.parse_expr()?);
            }
        }
        self.expect(Tt::RParen, "')' to close a function call")?;
        Ok((args, distinct, star))
    }

    fn parse_case(&mut self) -> R<Expr> {
        self.expect_kw("case")?;
        let subject = if self.check_kw("when") {
            None
        } else {
            Some(Box::new(self.parse_expr()?))
        };
        let mut whens = Vec::new();
        while self.check_kw("when") {
            self.advance();
            let when = self.parse_expr()?;
            self.expect_kw("then")?;
            whens.push((when, self.parse_expr()?));
        }
        if whens.is_empty() {
            return err("CASE requires at least one WHEN ... THEN", self.peek().pos);
        }
        let else_ = if self.check_kw("else") {
            self.advance();
            Some(Box::new(self.parse_expr()?))
        } else {
            None
        };
        self.expect_kw("end")?;
        Ok(Expr::Case {
            subject,
            whens,
            else_,
        })
    }

    fn parse_primary(&mut self) -> R<Expr> {
        let t = self.peek().clone();
        match t.tt {
            Tt::Number => {
                self.advance();
                Ok(Expr::Lit(Lit::Num(t.num.unwrap())))
            }
            Tt::Str => {
                self.advance();
                Ok(Expr::Lit(Lit::Str(t.value)))
            }
            Tt::Param => {
                self.advance();
                Ok(Expr::Param(t.value))
            }
            Tt::Keyword if t.value == "true" || t.value == "false" => {
                self.advance();
                Ok(Expr::Lit(Lit::Bool(t.value == "true")))
            }
            Tt::Keyword if t.value == "null" => {
                self.advance();
                Ok(Expr::Lit(Lit::Null))
            }
            Tt::Keyword if t.value == "case" => self.parse_case(),
            Tt::Keyword if t.value == "exists" => {
                self.advance();
                let (patterns, where_) = self.parse_braced_subquery()?;
                Ok(Expr::Exists {
                    patterns,
                    where_: where_.map(Box::new),
                })
            }
            Tt::Keyword if t.value == "count" => {
                self.advance();
                if self.check(Tt::LBrace) {
                    let (patterns, where_) = self.parse_braced_subquery()?;
                    Ok(Expr::CountSubquery {
                        patterns,
                        where_: where_.map(Box::new),
                    })
                } else {
                    let (args, distinct, star) = self.parse_call_args()?;
                    Ok(Expr::Func {
                        name: "count".into(),
                        args,
                        distinct,
                        star,
                    })
                }
            }
            Tt::LParen => {
                self.advance();
                let inner = self.parse_expr()?;
                self.expect(Tt::RParen, "')'")?;
                Ok(inner)
            }
            Tt::LBracket => {
                self.advance();
                let mut items = Vec::new();
                if !self.check(Tt::RBracket) {
                    loop {
                        items.push(self.parse_expr()?);
                        if self.check(Tt::Comma) {
                            self.advance();
                        } else {
                            break;
                        }
                    }
                }
                self.expect(Tt::RBracket, "']' to close a list")?;
                Ok(Expr::List(items))
            }
            Tt::Ident => {
                self.advance();
                // Function call: the name may be a reserved word (UPPER, SUM, ABS).
                if self.check(Tt::LParen) {
                    let (args, distinct, star) = self.parse_call_args()?;
                    return Ok(Expr::Func {
                        name: t.value.to_ascii_lowercase(),
                        args,
                        distinct,
                        star,
                    });
                }
                if !t.delimited && is_reserved(&t.value) {
                    return err(
                        format!(
                            "'{}' is a reserved word; quote it as a delimited identifier",
                            t.value
                        ),
                        t.pos,
                    );
                }
                if self.check(Tt::Dot) {
                    self.advance();
                    let key = self.bind_name("a property name")?;
                    return Ok(Expr::Prop {
                        variable: t.value,
                        key,
                    });
                }
                Ok(Expr::Var(t.value))
            }
            _ => {
                let got = if t.value.is_empty() {
                    format!("{:?}", t.tt)
                } else {
                    t.value
                };
                err(format!("Unexpected '{got}' in expression"), t.pos)
            }
        }
    }

    // --- return / projection ----------------------------------------------

    fn parse_return_item(&mut self) -> R<ReturnItem> {
        let expr = self.parse_expr()?;
        let alias = if self.check_kw("as") {
            self.advance();
            Some(self.bind_name("an alias name")?)
        } else {
            None
        };
        Ok(ReturnItem { expr, alias })
    }

    fn parse_sort_item(&mut self) -> R<SortItem> {
        let expr = self.parse_expr()?;
        let mut descending = false;
        if self.check_kw("desc") || self.check_kw("descending") {
            self.advance();
            descending = true;
        } else if self.check_kw("asc") || self.check_kw("ascending") {
            self.advance();
        }
        let mut nulls_first = None;
        if self.check_kw("nulls") {
            self.advance();
            if self.check_soft("first") {
                self.advance();
                nulls_first = Some(true);
            } else if self.check_soft("last") {
                self.advance();
                nulls_first = Some(false);
            } else {
                return err("Expected FIRST or LAST after NULLS", self.peek().pos);
            }
        }
        Ok(SortItem {
            expr,
            descending,
            nulls_first,
        })
    }

    fn parse_projection(&mut self) -> R<Projection> {
        let distinct = if self.check_kw("distinct") {
            self.advance();
            true
        } else {
            false
        };
        let mut star = false;
        let mut items = Vec::new();
        if self.check(Tt::Star) {
            self.advance();
            star = true;
        } else {
            items.push(self.parse_return_item()?);
            while self.check(Tt::Comma) {
                self.advance();
                items.push(self.parse_return_item()?);
            }
        }
        let mut order_by = Vec::new();
        if self.check_kw("order") {
            self.advance();
            self.expect_kw("by")?;
            order_by.push(self.parse_sort_item()?);
            while self.check(Tt::Comma) {
                self.advance();
                order_by.push(self.parse_sort_item()?);
            }
        }
        let mut skip = None;
        if self.check_kw("skip") || self.check_kw("offset") {
            self.advance();
            skip = Some(
                self.expect(Tt::Number, "a number after SKIP/OFFSET")?
                    .num
                    .unwrap() as usize,
            );
        }
        let mut limit = None;
        if self.check_kw("limit") {
            self.advance();
            limit = Some(
                self.expect(Tt::Number, "a number after LIMIT")?
                    .num
                    .unwrap() as usize,
            );
        }
        Ok(Projection {
            star,
            items,
            distinct,
            order_by,
            skip,
            limit,
        })
    }

    fn parse_with_clause(&mut self) -> R<WithClause> {
        self.expect_kw("with")?;
        let projection = self.parse_projection()?;
        let where_ = if self.check_kw("where") {
            self.advance();
            Some(self.parse_expr()?)
        } else {
            None
        };
        Ok(WithClause { projection, where_ })
    }

    // --- write clauses -----------------------------------------------------

    fn parse_insert_clause(&mut self) -> R<Vec<PathPattern>> {
        self.expect_kw("insert")?;
        let mut patterns = vec![self.parse_path_pattern()?];
        while self.check(Tt::Comma) {
            self.advance();
            patterns.push(self.parse_path_pattern()?);
        }
        Ok(patterns)
    }

    fn parse_set_item(&mut self) -> R<SetItem> {
        let variable = self.bind_name("a variable")?;
        if self.check(Tt::Colon) || self.check_kw("is") {
            self.advance();
            return Ok(SetItem::Label {
                variable,
                label: self.bind_name("a label name")?,
            });
        }
        self.expect(Tt::Dot, "'.' or ':'")?;
        let key = self.bind_name("a property name")?;
        self.expect(Tt::Eq, "'='")?;
        Ok(SetItem::Prop {
            variable,
            key,
            value: self.parse_expr()?,
        })
    }

    fn parse_set_clause(&mut self) -> R<Vec<SetItem>> {
        self.expect_kw("set")?;
        let mut items = vec![self.parse_set_item()?];
        while self.check(Tt::Comma) {
            self.advance();
            items.push(self.parse_set_item()?);
        }
        Ok(items)
    }

    fn parse_remove_item(&mut self) -> R<RemoveItem> {
        let variable = self.bind_name("a variable")?;
        if self.check(Tt::Colon) || self.check_kw("is") {
            self.advance();
            return Ok(RemoveItem::Label {
                variable,
                label: self.bind_name("a label name")?,
            });
        }
        self.expect(Tt::Dot, "'.' or ':'")?;
        Ok(RemoveItem::Prop {
            variable,
            key: self.bind_name("a property name")?,
        })
    }

    fn parse_remove_clause(&mut self) -> R<Vec<RemoveItem>> {
        self.expect_kw("remove")?;
        let mut items = vec![self.parse_remove_item()?];
        while self.check(Tt::Comma) {
            self.advance();
            items.push(self.parse_remove_item()?);
        }
        Ok(items)
    }

    fn parse_delete_clause(&mut self) -> R<Clause> {
        let detach = if self.check_kw("detach") {
            self.advance();
            true
        } else {
            false
        };
        if !detach && self.check_kw("nodetach") {
            self.advance();
        }
        self.expect_kw("delete")?;
        let mut targets = vec![self.parse_expr()?];
        while self.check(Tt::Comma) {
            self.advance();
            targets.push(self.parse_expr()?);
        }
        Ok(Clause::Delete { detach, targets })
    }

    fn parse_linear_query(&mut self) -> R<LinearQuery> {
        let mut clauses = Vec::new();
        let mut done = false;
        while !done && !self.at_end() {
            if self.check_kw("return") {
                self.advance();
                clauses.push(Clause::Return(self.parse_projection()?));
                done = true;
            } else if self.check_kw("finish") {
                self.advance();
                clauses.push(Clause::Finish);
                done = true;
            } else if self.check_kw("with") {
                clauses.push(Clause::With(self.parse_with_clause()?));
            } else if self.check_kw("match") || self.check_kw("optional") {
                clauses.push(Clause::Match(self.parse_match_clause()?));
            } else if self.check_kw("insert") {
                clauses.push(Clause::Insert(self.parse_insert_clause()?));
            } else if self.check_kw("set") {
                clauses.push(Clause::Set(self.parse_set_clause()?));
            } else if self.check_kw("remove") {
                clauses.push(Clause::Remove(self.parse_remove_clause()?));
            } else if self.check_kw("delete")
                || self.check_kw("detach")
                || self.check_kw("nodetach")
            {
                clauses.push(self.parse_delete_clause()?);
            } else {
                break;
            }
        }
        if clauses.is_empty() {
            let t = self.peek();
            let got = if t.value.is_empty() {
                format!("{:?}", t.tt)
            } else {
                t.value.clone()
            };
            return err(
                format!("Expected a clause (MATCH, INSERT, RETURN, …), got '{got}'"),
                t.pos,
            );
        }
        Ok(LinearQuery { clauses })
    }

    fn parse_query(&mut self) -> R<Query> {
        let mut parts = vec![self.parse_linear_query()?];
        let mut ops = Vec::new();
        loop {
            let op = if self.peek().tt == Tt::Keyword {
                match self.peek().value.as_str() {
                    "union" => Some(SetOpKind::Union),
                    "except" => Some(SetOpKind::Except),
                    "intersect" => Some(SetOpKind::Intersect),
                    _ => None,
                }
            } else {
                None
            };
            let Some(op) = op else { break };
            self.advance();
            let all = if self.check_kw("all") {
                self.advance();
                true
            } else {
                if self.check_kw("distinct") {
                    self.advance();
                }
                false
            };
            ops.push(SetOp { op, all });
            parts.push(self.parse_linear_query()?);
        }
        if !self.at_end() {
            let t = self.peek();
            let got = if t.value.is_empty() {
                format!("{:?}", t.tt)
            } else {
                t.value.clone()
            };
            return err(format!("Unexpected trailing input '{got}'"), t.pos);
        }
        Ok(Query { parts, ops })
    }
}
